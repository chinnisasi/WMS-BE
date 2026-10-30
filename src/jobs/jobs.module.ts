import { Inject, Injectable, Logger, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InFlightTick } from '../shared/lifecycle/shutdown';
import { WorkerHealthServer } from '../shared/lifecycle/worker-health-server';
import { ConfigRefusal } from '../shared/lifecycle/process-role';
import { sql } from 'drizzle-orm';
import { SharedModule, AUTH_DATABASE, DATABASE } from '../shared/shared.module';
import { checkSessionVisibility } from '../shared/db/open-transactions';
import type { Database } from '../shared/db/db';
import { OUTBOX_RELAY } from '../shared/events/outbox.seam';
import type { OutboxRelay } from '../shared/events/outbox.seam';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import { MovementsModule } from '../modules/movements/movements.module';
import { MovementsFacade, MAX_SCHEDULED_TASKS_PER_TICK } from '../modules/movements/transfer.facade';
import { ReplenishmentModule } from '../modules/replenishment/replenishment.module';
import { ReplenishmentFacade, MAX_REPLENISHMENT_SCOPES_PER_TICK } from '../modules/replenishment/replenishment.facade';
import { ChannelsModule } from '../modules/channels/channels.module';
import { ChannelsFacade } from '../modules/channels/channels.facade';
import { BillingModule } from '../modules/billing/billing.module';
import { BillingFacade } from '../modules/billing/billing.facade';
import { OutboundModule } from '../modules/outbound/outbound.module';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { NotificationsFacade, PUSH_SENDING_STALE_MS } from '../modules/notifications/notifications.facade';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { AUDIT_EXPORT_STALE_MINUTES } from '../modules/tenancy/audit-export.runner';
import { purgeEndedSessions } from '../modules/tenancy/sessions';
import { purgeAuthCounters } from '../modules/tenancy/auth-attempts';
import { purgeSecondFactorState } from '../modules/tenancy/second-factor';
import { purgeResetTokens } from '../modules/tenancy/password-reset';
import { ComplianceModule } from '../modules/compliance/compliance.module';
import { MailModule } from '../modules/mail/mail.module';
import { AttachmentsModule } from '../modules/attachments/attachments.module';
import { AttachmentsFacade, UPLOADING_MAX_AGE_MS } from '../modules/attachments/attachments.facade';
import {
  EMAIL_FINAL_STATUSES,
  EMAIL_PENDING_EXPIRY_MS,
  EMAIL_RETENTION_DAYS,
  EMAIL_PRIORITY_RESERVE,
  EMAIL_SENDING_STALE_MS,
  MailFacade,
} from '../modules/mail/mail.facade';
import { ClientWebhooksModule } from '../modules/client-webhooks/client-webhooks.module';
import { ClientWebhooksFacade } from '../modules/client-webhooks/client-webhooks.facade';
import { WEBHOOK_RETENTION_DAYS } from '../modules/client-webhooks/webhook-rules';
import type { WebhookSendSummary, WebhookTenantRun, WebhookTick } from '../modules/client-webhooks/webhook.sender';
import { LicenceFacade } from '../modules/compliance/licence.facade';
import { licenceToday } from '../modules/compliance/licence.command';
import { LICENCE_WARNING_LEAD_DAYS } from '../shared/primitives/licence';
import { addIsoDays } from '../shared/primitives/time';

/** The problem code a failed ATP read fails closed with (A8's store split). */
function codeOf(error: ProblemException): string | null {
  const response = error.getResponse() as { code?: unknown };
  return typeof response.code === 'string' ? response.code : null;
}

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
    throw new ConfigRefusal(
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
    throw new ConfigRefusal(
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
    throw new ConfigRefusal(
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
    throw new ConfigRefusal(
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
    throw new ConfigRefusal(
      `REPLENISHMENT_SCHEDULER_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/** Per-cycle publish bound (story 7-1's T3): a tick syncs at most this many connections. */
export const MAX_SYNC_CONNECTIONS_PER_TICK = 200;

/**
 * The channels sync worker's poll interval, in milliseconds, from
 * `CHANNELS_SYNC_POLL_MS` — the same env-gate conventions as the sibling
 * workers (unset/`0` is OFF — a deployment that publishes availability sets
 * e.g. `60000` for the 60s sync-health SLO with headroom; a non-negative
 * integer is required or the boot fails loudly; tests drive the facade's
 * `publishConnectionSnapshot()` directly).
 */
export function parseChannelsSyncPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigRefusal(
      `CHANNELS_SYNC_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
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
export class OutboxRelayWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxRelayWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(@Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay) {
    this.pollMs = parseOutboxPollMs(process.env.OUTBOX_RELAY_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that drains elsewhere)
    }
    this.logger.log(`Outbox relay worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('outbox-relay', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
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
export class ReconciliationWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('ReconciliationWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(@Inject(InventoryFacade) private readonly inventory: InventoryFacade) {
    this.pollMs = parseReconcilePollMs(process.env.OUTBOX_RECONCILE_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that reconciles elsewhere)
    }
    this.logger.log(`Reconciliation worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('reconciliation', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
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
export class ReservationReaper implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('ReservationReaper');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(@Inject(InventoryFacade) private readonly inventory: InventoryFacade) {
    this.pollMs = parseReservationReaperPollMs(process.env.RESERVATION_REAPER_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that reaps elsewhere)
    }
    this.logger.log(`Reservation reaper started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('reservation-reaper', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
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
export class CountSchedulerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('CountSchedulerWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

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
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('count-scheduler', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
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
        this.ticks.beat(); // Story 6-2c (A3): one beat per scope
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
export class ReplenishmentSchedulerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('ReplenishmentSchedulerWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();
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
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('replenishment-scheduler', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
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
      // 3. every warehouse carrying batch on-hand on a BATCH-TRACKED SKU of a
      //    tenant WITH an expiry-alert config (the expiry scan's alert
      //    sources — the projection's positive rows are the only scopes a
      //    batch alert can detect against, and a tenant with no config row
      //    scans to a no-op, so enumerating it is pure waste), UNION every
      //    warehouse with an OPEN batch alert — the consumed-warehouse arm:
      //    once a warehouse's LAST positive batch row is gone its on-hand
      //    query would never name it again, and the auto-resolve of its open
      //    alerts (on-hand 0) would never run. The union keeps them swept
      //    until every alert settles. The EXISTS rides the on-hand arm ONLY —
      //    the open-alert arm needs no config check (the table has no DELETE;
      //    an open alert implies the config row existed). The dedupe map
      //    below absorbs any overlap with queries 1-2.
      const batchScopes = (await this.authDb.execute(sql`
        select tenant_id as "tenantId", warehouse_id as "warehouseId" from (
          select bo.tenant_id, bo.warehouse_id
          from batch_on_hand bo
          join skus s on s.tenant_id = bo.tenant_id and s.id = bo.sku_id
          where bo.quantity > 0 and s.batch_tracked
            and exists (
              select 1 from expiry_alert_policies p
              where p.tenant_id = bo.tenant_id
            )
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
        this.ticks.beat(); // Story 6-2c (A3): one beat per scope
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
 * The channels sync worker (story 7-1's T3): an interval poll loop over the
 * tenant's connected connections — one tick enumerates every CONNECTED
 * integration whose breaker is not open, cross-tenant (the count scheduler's
 * `authDb` BYPASSRLS precedent; the enumeration is read-only, every WRITE
 * stays on the facade's tenant transactions), capped at
 * `MAX_SYNC_CONNECTIONS_PER_TICK` per cycle in deterministic order, and
 * drives `ChannelsFacade.publishConnectionSnapshot(tenantId, connectionId)`
 * for each: read row + mappings, compute the per-scope visible quantities
 * (RN-6's committed reads), append ONE outbox message per (connection,
 * cycle); the relay delivers, the delivery handler meters + breakers.
 *
 * A failing connection is logged and retried next tick (the scheduler's
 * per-scope rationale) — a poison connection must not starve the rest: any
 * failure other than the store-down stall is logged (naming the connection
 * and the reason) and the cycle moves on to the next connection. A
 * reservation-store-down cycle (503 `reservation-store-unavailable` from
 * an ATP read) is a STALL, not a skip: the facade's `recordSyncStall`
 * stamps `last_error`/`last_attempt_at` so the connection's health DEGRADES
 * (visible in arm 4's list), nothing is appended (the sync never invents
 * zero — PENDING a8), and this is NOT a breaker stroke (RN-5's breaker
 * guards runaway DELIVERY loops; the compute-side store-down is the
 * reservation core's fail-closed mode).
 *
 * Env-gated OFF when `CHANNELS_SYNC_POLL_MS` is unset/`0` (tests drive the
 * facade directly), shed via the in-process `running` flag, `unref`'d
 * timer, and a shutdown hook.
 */
@Injectable()
export class ChannelsSyncWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('ChannelsSyncWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    // The cross-tenant enumeration read (BYPASSRLS — the count scheduler's
    // `authDb` precedent); every WRITE stays on the facade's tenant
    // transactions.
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(ChannelsFacade) private readonly channels: ChannelsFacade,
  ) {
    this.pollMs = parseChannelsSyncPollMs(process.env.CHANNELS_SYNC_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that syncs elsewhere)
    }
    this.logger.log(`Channels sync worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('channels-sync', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    // Never hold the process open on the timer alone: shutdown hooks end it.
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // Cross-tenant, read-only (BYPASSRLS): every connected connection
      // whose breaker is open is left alone — only a `retry` half-opens it
      // (RN-5), and a `skipped` append costs nothing anyway, but skipping
      // the whole cycle here keeps the enumeration honest about what CAN
      // publish. Deterministic order; capped at
      // MAX_SYNC_CONNECTIONS_PER_TICK with a truncation warn (a
      // head-only slice here delays — one tick's lag — rather than starves,
      // because the connection set re-enters the next cycle naturally).
      const connections = (await this.authDb.execute(sql`
        select tenant_id as "tenantId", id as "connectionId"
        from integrations
        where status = 'connected' and breaker_state <> 'open'
        order by tenant_id asc, created_at asc, id asc
        limit ${MAX_SYNC_CONNECTIONS_PER_TICK}
      `)) as unknown as { tenantId: string; connectionId: string }[];

      let published = 0;
      for (const { tenantId, connectionId } of connections) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per connection
        try {
          const outcome = await this.channels.publishConnectionSnapshot(tenantId, connectionId);
          if (outcome === true) {
            published += 1;
          }
          // `false` (breaker open / nothing mapped / not connected — a
          // silent skip, no stall) and `'absent'` (the row left mid-cycle)
          // both just continue.
        } catch (error) {
          const status = error instanceof ProblemException ? error.getStatus() : null;
          const code = error instanceof ProblemException ? codeOf(error) : null;
          if (status === 503 && code === 'reservation-store-unavailable') {
            // The snapshot's ATP read failed closed: stamp the stall
            // (health degrades), publish nothing, retry next tick. The
            // stamp itself is best-effort — a recordSyncStall failure is
            // logged by the outer catch of the NEXT cycle; here it would
            // only hide the original reason, so it rides the local try.
            this.logger.warn(
              `Channels sync stalled for connection ${connectionId}: the reservation store is down — stamped, nothing published`,
            );
            try {
              await this.channels.recordSyncStall(tenantId, connectionId, 'reservation store unavailable');
            } catch (stampError) {
              this.logger.error(
                `Channels sync could not stamp the stall for connection ${connectionId}: ` +
                  `${stampError instanceof Error ? stampError.message : String(stampError)}`,
              );
            }
            continue;
          }
          // Every OTHER failure is a per-connection skip, not a cycle
          // abort: one poison connection must not abort the cycle and
          // starve every later connection (the head rule). Log with the
          // connection and the reason, move on, retry next tick.
          this.logger.error(
            `Channels sync failed for connection ${connectionId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      if (published > 0) {
        this.logger.log(`Channels sync appended ${published} publication(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Channels sync cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/**
 * The storage snapshot worker's poll interval, in milliseconds, from
 * `STORAGE_SNAPSHOT_POLL_MS` (story 21-4) — the sibling workers' env-gate
 * conventions (unset/`0` is OFF — a deployment that bills client brands sets
 * e.g. `300000`; a non-negative integer is required or the boot fails
 * loudly; tests drive `tick()` and the facade directly).
 */
export function parseStorageSnapshotPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigRefusal(
      `STORAGE_SNAPSHOT_POLL_MS must be a non-negative integer of milliseconds (got "${raw}")`,
    );
  }
  return parsed;
}

/** Per-tick scope bound (story 21-4): a tick snapshots at most this many (client, warehouse) scopes. */
export const MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK = 200;

/**
 * Story 21-4 — the daily storage snapshot worker (FR-78, CAP-6). Each tick:
 * discovers every tenant cross-tenant (BYPASSRLS read — the replenishment
 * scheduler's `authDb` precedent; the enumeration is read-only), lists each
 * tenant's scopes through `BillingFacade.snapshotScopesOf` — non-`self`
 * clients × the warehouses they have ledger events in (a tenant with no
 * client brand yields none) — and runs one `snapshotScope` per scope, each
 * in its own tenant transaction under its own advisory lock. The scope set
 * is capped per tick with a ROTATING window (a head-only slice would starve
 * the tail forever), and a failing tenant or scope is logged and retried
 * next tick, never starving the rest. A scope writes at most 31 days per
 * call, so a backfill advances a month per tick. Single-flight in-process
 * (`running`); two instances are safe — the per-scope advisory lock
 * serialises them and the watermark only moves forward. Env-gated OFF when
 * `STORAGE_SNAPSHOT_POLL_MS` is unset/`0`; `unref`'d timer; shutdown hook.
 */
@Injectable()
export class StorageSnapshotWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('StorageSnapshotWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();
  /** The truncating ticks' rotating-window offset. */
  private tickOffset = 0;

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(BillingFacade) private readonly billing: BillingFacade,
    /** The app role — checked once at boot for `pg_read_all_stats` (§7d). */
    @Inject(DATABASE) private readonly db?: Database,
  ) {
    this.pollMs = parseStorageSnapshotPollMs(process.env.STORAGE_SNAPSHOT_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that bills nobody)
    }
    this.logger.log(`Storage snapshot worker started (poll every ${this.pollMs}ms)`);
    if (this.db !== undefined) void checkSessionVisibility(this.db, this.logger, 'Storage snapshot worker');
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('storage-snapshot', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One cycle. `nowMs` is the snapshot clock (default the wall clock) — the
   * tests pass a fixed instant so the IST-day arithmetic is deterministic.
   * Returns how many scopes it carried (the plumbing tests read it).
   */
  async tick(nowMs: number = Date.now()): Promise<{ carried: number; total: number }> {
    if (this.running) {
      return { carried: 0, total: 0 }; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select id as "tenantId" from tenants order by id asc
      `)) as unknown as { tenantId: string }[];
      const scopes: { tenantId: string; clientId: string; warehouseId: string }[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          scopes.push(...(await this.billing.snapshotScopesOf(tenantId)));
        } catch (error) {
          this.logger.error(
            `Storage snapshot worker could not list the scopes of tenant ${tenantId} — skipped this cycle: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const carried =
        scopes.length <= MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK
          ? scopes
          : this.rotatingWindow(scopes, MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK);
      if (scopes.length > carried.length) {
        this.logger.warn(
          `Storage snapshot worker carried ${carried.length} of ${scopes.length} scope(s) this tick ` +
            `— the rotating window advances each tick until every scope is snapshotted`,
        );
      }
      for (const scope of carried) {
        this.ticks.beat(); // and per scope
        try {
          await this.billing.snapshotScope(scope.tenantId, scope.clientId, scope.warehouseId, nowMs);
        } catch (error) {
          this.logger.error(
            `Storage snapshot worker could not snapshot client ${scope.clientId} in warehouse ${scope.warehouseId} ` +
              `— skipped this cycle: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { carried: carried.length, total: scopes.length };
    } catch (error) {
      this.logger.error(
        `Storage snapshot cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { carried: 0, total: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * `cap` scopes from the tick offset, wrapping; the offset advances by the
   * number of scopes CARRIED, so the next tick starts where this one stopped
   * and every scope is reached within ⌈length / cap⌉ ticks (a one-scope
   * advance would leave the tail waiting ~length ticks).
   */
  private rotatingWindow<T>(ordered: readonly T[], cap: number): T[] {
    const start = this.tickOffset % ordered.length;
    const window: T[] = [];
    for (let i = 0; i < cap && i < ordered.length; i += 1) {
      const scope = ordered[(start + i) % ordered.length];
      if (scope !== undefined) {
        window.push(scope);
      }
    }
    this.tickOffset = (start + window.length) % ordered.length;
    return window;
  }
}

/**
 * jobs shell — background/relay workers (outbox relay, reconciliation,
 * reservation reaper, count scheduler, replenishment scheduler, channels
 * sync, import batches, notifications dispatch). The event bus + outbox
 * seams live in
 * shared/events and are provided by SharedModule. All workers are env-gated
 * OFF unless `OUTBOX_RELAY_POLL_MS` / `OUTBOX_RECONCILE_POLL_MS` /
 * `RESERVATION_REAPER_POLL_MS` / `COUNT_SCHEDULER_POLL_MS` /
 * `REPLENISHMENT_SCHEDULER_POLL_MS` / `CHANNELS_SYNC_POLL_MS` /
 * `STORAGE_SNAPSHOT_POLL_MS` is set (tests
 * exercise `drain()` / `reconcileNext()` / `expireDueReservations()` /
 * `generateScheduledCountTasks()` / `sweepScope()` /
 * `publishConnectionSnapshot()` directly, plus one plumbing test driving
 * `ReplenishmentSchedulerWorker.tick()` itself).
 */
/**
 * A non-negative integer of milliseconds from an env poll variable — unset or
 * `0` is OFF (tests drive the facades and `tick()` directly); anything else
 * fails the boot loudly. The sibling parsers' convention, named once for the
 * two story 9-2b workers.
 */
function parsePollMs(name: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigRefusal(`${name} must be a non-negative integer of milliseconds (got "${raw}")`);
  }
  return parsed;
}

/** `PUSH_SENDER_POLL_MS` (story 9-2b): the push sender's poll; unset/`0` = OFF. */
export function parsePushSenderPollMs(raw: string | undefined): number {
  return parsePollMs('PUSH_SENDER_POLL_MS', raw);
}

/** `WAVE_CUTOFF_SWEEP_POLL_MS` (story 9-2b): the wave cutoff sweep's poll; unset/`0` = OFF. */
export function parseWaveCutoffSweepPollMs(raw: string | undefined): number {
  return parsePollMs('WAVE_CUTOFF_SWEEP_POLL_MS', raw);
}

/** `LICENCE_EXPIRY_POLL_MS` (story 1-6c): the licence expiry sweep's poll; unset/`0` = OFF. */
export function parseLicenceExpiryPollMs(raw: string | undefined): number {
  return parsePollMs('LICENCE_EXPIRY_POLL_MS', raw);
}

/**
 * Story 9-2b — the push sender worker. Each tick finds the tenants with due
 * push rows — `pending` past `next_attempt_at`, or `sending` past the
 * 5-minute stale bound — cross-tenant on the read-only BYPASSRLS
 * `AUTH_DATABASE` (the `ReplenishmentSchedulerWorker` precedent; every
 * write stays in the facade's tenant transactions), and calls
 * `NotificationsFacade.sendDuePushes(tenantId)` once per tenant (≤ 100 rows,
 * one gateway call). A failing tenant is logged and retried next tick.
 * Env-gated OFF when `PUSH_SENDER_POLL_MS` is unset/`0`; single-flight via
 * `running`; `unref`'d timer; shutdown hook. Two instances are safe: the
 * claim is `FOR UPDATE SKIP LOCKED` and committed `sending` before the send.
 */
@Injectable()
export class PushSenderWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('PushSenderWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(NotificationsFacade) private readonly notifications: NotificationsFacade,
  ) {
    this.pollMs = parsePushSenderPollMs(process.env.PUSH_SENDER_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Push sender worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('push-sender', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it drove (the plumbing test reads it). */
  async tick(): Promise<string[]> {
    if (this.running) {
      return []; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // The stale bound is the sender's own constant (code review B5) — a
      // hardcoded interval here would drift from the sweep it gates.
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId"
        from push_deliveries
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'sending' and updated_at < now() - make_interval(secs => ${PUSH_SENDING_STALE_MS / 1000}::double precision))
        order by tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const driven: string[] = [];
      const configCodes = new Set<string>();
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          const summary = await this.notifications.sendDuePushes(tenantId);
          for (const code of summary.configCodes) configCodes.add(code);
          driven.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Push sender could not send for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (configCodes.size > 0) {
        // ONCE per tick, across every tenant (code review B4): the
        // deployment's credentials are wrong. Codes only — never a provider
        // message (it names the token).
        this.logger.error(
          `push gateway refused the credentials (${[...configCodes].sort().join(', ')}) — check EXPO_ACCESS_TOKEN; ` +
            'rows retried without spending an attempt, expired after 30 minutes',
        );
      }
      return driven;
    } catch (error) {
      this.logger.error(`Push sender cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `EMAIL_SEND_POLL_MS` (story 5-1a): the email sender's poll; unset/`0` = OFF. */
export function parseEmailSendPollMs(raw: string | undefined): number {
  return parsePollMs('EMAIL_SEND_POLL_MS', raw);
}

/**
 * Story 5-1a — the email sender worker (the `PushSenderWorker` shape). Each
 * tick finds the tenants with mail work cross-tenant on the read-only
 * BYPASSRLS `AUTH_DATABASE` — a due `pending` row, a `pending` row past the
 * 24-hour expiry, a `sending` row past the 10-minute stale bound, or a final
 * row past the 90-day retention (its own arm, so an idle tenant is purged
 * too) — and calls `MailFacade.sendDue(tenantId, remaining)` once per
 * tenant, where `remaining` is what is left of `EMAIL_MAX_PER_TICK` this
 * tick (the SES send rate is per account, not per tenant; the walk starts
 * one tenant later each tick, so no backlog starves the others). A failing tenant
 * is logged and retried next tick; config faults are logged ONCE per tick,
 * by code. Env-gated OFF when `EMAIL_SEND_POLL_MS` is unset/`0`;
 * single-flight; `unref`'d timer; the 6-2a shutdown drain. Two instances are
 * safe: the claim is `FOR UPDATE SKIP LOCKED` and commits `sending` before
 * the send.
 */
@Injectable()
export class EmailSenderWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('EmailSenderWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Ticks run so far — rotates where each tick's tenant walk starts. */
  private tickCount = 0;
  private readonly ticks = new InFlightTick();
  /**
   * Story 5-2b (A7, D7) — account rows (priority 0) each tenant may still
   * claim once the shared budget is spent. A plain field so a suite can
   * isolate the budget's rotation from the reserve.
   */
  priorityReserve = EMAIL_PRIORITY_RESERVE;

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(MailFacade) private readonly mail: MailFacade,
  ) {
    this.pollMs = parseEmailSendPollMs(process.env.EMAIL_SEND_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Email sender worker started (poll every ${this.pollMs}ms)`);
    this.ticks.track('email-sender', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it drove (the plumbing test reads it). */
  async tick(): Promise<string[]> {
    if (this.running) {
      return []; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // The bounds are the sender's own constants — a hardcoded interval
      // here would drift from the sweeps it gates.
      const finals = sql.join(EMAIL_FINAL_STATUSES.map((status) => sql`${status}`), sql`, `);
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId"
        from email_messages
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'pending' and created_at < now() - make_interval(secs => ${EMAIL_PENDING_EXPIRY_MS / 1000}::double precision))
           or (status = 'sending' and updated_at < now() - make_interval(secs => ${EMAIL_SENDING_STALE_MS / 1000}::double precision))
           or (status in (${finals}) and updated_at < now() - make_interval(days => ${EMAIL_RETENTION_DAYS}))
        order by tenant_id asc
      `)) as unknown as { tenantId: string }[];
      let remaining = this.mail.maxPerTick();
      // Story 5-2b (A7) — ONE reserve budget per tick, equal to the cap: the
      // account rows sent past the spent limit, across every tenant, never
      // exceed it (a tick's worst case is 2 × EMAIL_MAX_PER_TICK sends).
      let reserveLeft = this.mail.maxPerTick();
      const driven: string[] = [];
      const configCodes = new Set<string>();
      // Code review — the shared budget would let the first tenant's backlog
      // starve the rest every tick: the walk starts one tenant later each
      // tick (wrapping), and still visits every tenant for its sweeps.
      const start = tenants.length === 0 ? 0 : this.tickCount % tenants.length;
      this.tickCount += 1;
      const rotated = [...tenants.slice(start), ...tenants.slice(0, start)];
      for (const { tenantId } of rotated) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          // Every tenant is still visited once the budget is spent: its
          // sweeps (stale, expiry, purge) run with a zero send limit.
          // Story 5-2b (A7, D7) — with the budget spent, a tenant's account
          // mail (invites, resets) still takes up to the reserve.
          const limit = remaining;
          const summary = await this.mail.sendDue(tenantId, limit, { priorityReserve: Math.min(this.priorityReserve, reserveLeft) });
          reserveLeft = Math.max(0, reserveLeft - Math.max(0, summary.attempted - limit));
          remaining = Math.max(0, remaining - summary.attempted);
          for (const code of summary.configCodes) configCodes.add(code);
          driven.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Email sender could not send for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (configCodes.size > 0) {
        // ONCE per tick, across every tenant: the deployment is wrong
        // (credentials, a paused account, an unverified identity or sandbox
        // recipient). Codes only — never a provider message.
        this.logger.error(
          `email provider refused on configuration (${[...configCodes].sort().join(', ')}) — check EMAIL_FROM, the SES identity, ` +
            'IAM and the account status; rows retried without spending an attempt, expired after 24 hours',
        );
      }
      return driven;
    } catch (error) {
      this.logger.error(`Email sender cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `WEBHOOK_SEND_POLL_MS` (story 5-2a): the client webhook sender's poll; unset/`0` = OFF. */
export function parseWebhookSendPollMs(raw: string | undefined): number {
  return parsePollMs('WEBHOOK_SEND_POLL_MS', raw);
}

/** What the webhook worker drives — the facade, or a suite's fake. */
export interface WebhookSendDriver {
  newTick(onSend?: () => void): WebhookTick;
  sendDueWebhooks(tenantId: string, tick?: WebhookTick): Promise<WebhookTenantRun>;
}

/**
 * Story 5-2a — the client webhook sender worker (the `EmailSenderWorker`
 * shape, A3, A8). Each tick finds the tenants with webhook work cross-tenant
 * on the read-only BYPASSRLS `AUTH_DATABASE` — any endpoint that is not
 * deleted, or a deleted one past retention (every delivery and event hangs
 * off an endpoint) — and visits them through a
 * ROTATING window (the walk starts one tenant later each tick, so no backlog
 * starves the rest). Per tenant, `ClientWebhooksFacade.sendDueWebhooks` runs
 * the sweep and the claim and STARTS the sends in the tick's shared pool
 * (`WEBHOOK_SEND_CONCURRENCY`, 8): the worker does not wait for one tenant's
 * sends before claiming the next tenant's, so a hanging receiver costs its
 * own two slots, never another tenant's tick. The tick budget is 60 s (no
 * send starts after it). A failing tenant is logged and retried next tick;
 * config faults are logged ONCE per tick. Env-gated OFF when
 * `WEBHOOK_SEND_POLL_MS` is unset/`0`; single-flight; `unref`'d timer; the
 * 6-2a shutdown drain; the 6-2c heartbeat (one beat per tenant and per send,
 * 2-minute no-progress bound). Two instances are safe: the claim is `FOR
 * UPDATE SKIP LOCKED`, commits `sending` before any send, caps two in flight
 * per endpoint across processes, and every outcome is conditional on the
 * claim stamp.
 */
@Injectable()
export class WebhookSenderWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('WebhookSenderWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Ticks run so far — rotates where each tick's tenant walk starts. */
  private tickCount = 0;
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(ClientWebhooksFacade) private readonly webhooks: WebhookSendDriver,
  ) {
    this.pollMs = parseWebhookSendPollMs(process.env.WEBHOOK_SEND_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Webhook sender worker started (poll every ${this.pollMs}ms)`);
    this.ticks.track('webhook-sender', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it drove (the plumbing test reads it). */
  async tick(): Promise<string[]> {
    if (this.running) {
      return []; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      // Code review C10 — discovery reads the small endpoints table only: a
      // tenant with any live endpoint (its deliveries, held rows, departure
      // and reconcile), or a deleted one past retention (whose purge also
      // removes its deliveries, then the events left empty). Every delivery
      // and event belongs to an endpoint, so no delivery-table scan is needed.
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId" from webhook_endpoints
         where status <> 'deleted' or deleted_at < now() - make_interval(days => ${WEBHOOK_RETENTION_DAYS})
         order by 1 asc
      `)) as unknown as { tenantId: string }[];
      const start = tenants.length === 0 ? 0 : this.tickCount % tenants.length;
      this.tickCount += 1;
      const rotated = [...tenants.slice(start), ...tenants.slice(0, start)];
      const tick = this.webhooks.newTick(() => this.ticks.beat());
      const runs: { tenantId: string; done: Promise<WebhookSendSummary> }[] = [];
      const driven: string[] = [];
      for (const { tenantId } of rotated) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          // Every tenant is still visited once the claim budget is spent: its
          // sweep (expiry, purge, departure, reconcile) runs with no claim.
          const run = await this.webhooks.sendDueWebhooks(tenantId, tick);
          runs.push({ tenantId, done: run.done });
          driven.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Webhook sender could not run for tenant ${tenantId} — retried next tick: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const configCodes = new Set<string>();
      for (const run of runs) {
        try {
          const summary = await run.done;
          for (const code of summary.configCodes) configCodes.add(code);
        } catch (error) {
          this.logger.error(
            `Webhook sends failed for tenant ${run.tenantId} — the stale sweep returns them: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (configCodes.size > 0) {
        // ONCE per tick, across every tenant: the deployment is wrong.
        this.logger.error(
          `webhook signing secrets could not be opened (${[...configCodes].sort().join(', ')}) — check WEBHOOK_SEAL_KEY and WEBHOOK_SEAL_KEY_PREVIOUS; ` +
            'rows retried without spending an attempt, expired after 72 hours',
        );
      }
      return driven;
    } catch (error) {
      this.logger.error(`Webhook sender cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `BACKORDER_ALLOCATION_POLL_MS` (story 4-2c): the backorder allocation sweep's poll; unset/`0` = OFF. */
export function parseBackorderAllocationPollMs(raw: string | undefined): number {
  return parsePollMs('BACKORDER_ALLOCATION_POLL_MS', raw);
}

/**
 * Story 4-2c — the backorder allocation sweep worker. Each tick finds the
 * tenants with an `accepted` order (cross-tenant, read-only,
 * `AUTH_DATABASE` — the `orders_accepted_tenant_warehouse_idx` partial index)
 * and calls `OutboundFacade.sweepBackorders(tenantId)`, which re-reserves the
 * backordered lines that hold nothing when stock exists (at most 50 orders
 * allocated and 500 scanned per tenant per tick, urgency first). A failing
 * tenant is logged and retried next tick. Env-gated OFF when
 * `BACKORDER_ALLOCATION_POLL_MS` is unset/`0` (`.env.example` 600000 — ten
 * minutes); single-flight; `unref`'d timer.
 *
 * SAFE IN TWO WORKER PROCESSES: every write is the allocation's own phase 3
 * under the order row lock — an orphan hold is adopted, a line is written
 * only where it still names what the run read, and a grant is released only
 * when no line references it — so two sweeps over one order end with one
 * live hold on the line (pinned by the two-allocator race in
 * `test/order-follow-on.spec.ts`).
 */
@Injectable()
export class BackorderAllocationWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('BackorderAllocationWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {
    this.pollMs = parseBackorderAllocationPollMs(process.env.BACKORDER_ALLOCATION_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Backorder allocation worker started (poll every ${this.pollMs}ms)`);
    this.ticks.track('backorder-allocation', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it swept. */
  async tick(): Promise<string[]> {
    if (this.running) {
      return [];
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select distinct o.tenant_id as "tenantId"
        from orders o
        where o.status = 'accepted'
        order by o.tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const swept: string[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // one beat per tenant
        try {
          await this.outbound.sweepBackorders(tenantId);
          swept.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Backorder allocation failed for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return swept;
    } catch (error) {
      this.logger.error(`Backorder allocation cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/**
 * Story 9-2b — the wave cutoff sweep worker. Each tick finds the tenants with
 * a PLANNED wave under a policy that has a cutoff (cross-tenant, read-only,
 * `AUTH_DATABASE`) and calls `OutboundFacade.sweepCutoffRisk(tenantId)` —
 * which raises `wave.cutoff_at_risk` once per wave per IST date when the
 * cutoff is 0 < r ≤ 60 minutes away. A failing tenant is logged and retried
 * next tick. Env-gated OFF when `WAVE_CUTOFF_SWEEP_POLL_MS` is unset/`0`
 * (`.env.example` 60000 — a poll longer than a minute can skip the first
 * at-risk minute, never the window); single-flight; `unref`'d timer.
 */
@Injectable()
export class WaveCutoffSweepWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('WaveCutoffSweepWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {
    this.pollMs = parseWaveCutoffSweepPollMs(process.env.WAVE_CUTOFF_SWEEP_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Wave cutoff sweep worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('wave-cutoff-sweep', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it swept. */
  async tick(): Promise<string[]> {
    if (this.running) {
      return [];
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select distinct w.tenant_id as "tenantId"
        from waves w
        join wave_policies p on p.id = w.policy_id and p.tenant_id = w.tenant_id
        where w.status = 'planned' and p.cutoff_local_time is not null
        order by w.tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const swept: string[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          await this.outbound.sweepCutoffRisk(tenantId);
          swept.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Wave cutoff sweep failed for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return swept;
    } catch (error) {
      this.logger.error(`Wave cutoff sweep cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `AUDIT_EXPORT_POLL_MS` (story 9-3b): the audit export worker's poll; unset/`0` = OFF. */
export function parseAuditExportPollMs(raw: string | undefined): number {
  return parsePollMs('AUDIT_EXPORT_POLL_MS', raw);
}

/**
 * Story 9-3b — the async audit export worker (the `PushSenderWorker` shape).
 * Each tick finds the tenants with export work — a `queued` row, a `running`
 * row whose heartbeat is stale (15 minutes — the runner's own constant), or
 * a `ready`/`failed` row past its expiry — cross-tenant on the read-only
 * BYPASSRLS `AUTH_DATABASE` (every write stays in the runner's tenant
 * transactions), and calls `TenancyService.runDueAuditExports(tenantId)`
 * once per tenant (reclaim, expire, prove the snapshot, claim at most one
 * export, write it, finish). A failing tenant is logged and retried next
 * tick. Env-gated OFF when `AUDIT_EXPORT_POLL_MS` is unset/`0` — rows then
 * stay `queued` and the web reads "Preparing…". Single-flight via
 * `running`; `unref`'d timer; shutdown hook. Two instances are safe: the
 * claim is `FOR UPDATE SKIP LOCKED`, and a finish is conditional on the
 * claimed attempt.
 */
@Injectable()
export class AuditExportWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('AuditExportWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    /** The app role — checked once at boot for `pg_read_all_stats` (§7d). */
    @Inject(DATABASE) private readonly db?: Database,
  ) {
    this.pollMs = parseAuditExportPollMs(process.env.AUDIT_EXPORT_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Audit export worker started (poll every ${this.pollMs}ms)`);
    if (this.db !== undefined) void checkSessionVisibility(this.db, this.logger, 'Audit export worker');
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('audit-export', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it drove. */
  async tick(): Promise<string[]> {
    if (this.running) {
      return []; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId"
        from audit_exports
        where status = 'queued'
           or (status = 'running' and heartbeat_at < now() - make_interval(mins => ${AUDIT_EXPORT_STALE_MINUTES}))
           or (status in ('ready', 'failed') and expires_at < now())
        order by tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const driven: string[] = [];
      for (const { tenantId } of tenants) {
        // Story 6-2c (A3): one beat per tenant — one export can page a large
        // tenant inside the call, hence this job's 60 min bound (PENDING: a
        // per-page beat needs a seam across the module boundary).
        this.ticks.beat();
        try {
          const summary = await this.tenancy.runDueAuditExports(tenantId);
          if (summary.claimed !== null) {
            this.logger.log(`audit export ${summary.claimed} (tenant ${tenantId}): ${summary.outcome}`);
          } else if (summary.waiting !== null && summary.waiting !== 'grace') {
            this.logger.log(`audit export (tenant ${tenantId}) waiting: ${summary.waiting}`);
          }
          driven.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Audit export worker failed for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return driven;
    } catch (error) {
      this.logger.error(`Audit export cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `LEDGER_INTEGRITY_POLL_MS` (story 9-3c): the ledger integrity worker's poll; unset/`0` = OFF (recommended `3600000`). */
export function parseLedgerIntegrityPollMs(raw: string | undefined): number {
  return parsePollMs('LEDGER_INTEGRITY_POLL_MS', raw);
}

/** Per-tick scope bound (story 9-3c): a tick runs at most this many warehouses (a rotating window past that). */
export const DEFAULT_MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK = 50;

/** `MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK` — a positive integer; default 50; anything else fails the boot. */
export function parseMaxLedgerIntegrityScopesPerTick(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

/** The facade surface the worker drives — a seam so the window and the per-scope catch are testable with a fake. */
export type LedgerIntegrityDriver = Pick<InventoryFacade, 'ledgerIntegrityScopesOf' | 'runLedgerIntegrity'>;

/**
 * Story 9-3c — the ledger integrity worker (AD-16; the `StorageSnapshotWorker`
 * shape). Each tick: discovers every tenant cross-tenant on the read-only
 * BYPASSRLS `AUTH_DATABASE` (the enumeration is read-only; every write stays
 * in inventory's tenant transactions), lists each tenant's warehouses through
 * `InventoryFacade.ledgerIntegrityScopesOf`, and runs one
 * `InventoryFacade.runLedgerIntegrity(tenantId, warehouseId)` per scope —
 * baseline once, anchor the tail in bounded chunks, re-verify one anchored
 * range, copy anchors to WORM. The scope set is capped per tick at
 * `MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK` (default 50) with a ROTATING window,
 * and a failing tenant or scope is logged and retried next tick, never
 * starving the rest. Single-flight in-process (`running`); two instances are
 * safe — the baseline and every anchor take the warehouse advisory lock, a
 * break row is unique, a WORM copy row is `ON CONFLICT DO NOTHING`.
 * Env-gated OFF when `LEDGER_INTEGRITY_POLL_MS` is unset/`0` — the web then
 * reads "Not yet checked". `unref`'d timer; shutdown hook.
 */
@Injectable()
export class LedgerIntegrityWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('LedgerIntegrityWorker');
  private readonly pollMs: number;
  /** The per-tick cap — a plain field so a suite can shrink it. */
  maxScopesPerTick: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();
  /** The truncating ticks' rotating-window offset. */
  private tickOffset = 0;

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(InventoryFacade) private readonly inventory: LedgerIntegrityDriver,
  ) {
    this.pollMs = parseLedgerIntegrityPollMs(process.env.LEDGER_INTEGRITY_POLL_MS);
    this.maxScopesPerTick = parseMaxLedgerIntegrityScopesPerTick(process.env.MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off (tests, or a deployment that does not check its chain)
    }
    this.logger.log(`Ledger integrity worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('ledger-integrity', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle. Returns how many scopes it carried and how many exist. */
  async tick(): Promise<{ carried: number; total: number }> {
    if (this.running) {
      return { carried: 0, total: 0 }; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select id as "tenantId" from tenants order by id asc
      `)) as unknown as { tenantId: string }[];
      const scopes: { tenantId: string; warehouseId: string }[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant listing
        try {
          scopes.push(...(await this.inventory.ledgerIntegrityScopesOf(tenantId)));
        } catch (error) {
          this.logger.error(
            `Ledger integrity worker could not list the warehouses of tenant ${tenantId} — skipped this cycle: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const carried =
        scopes.length <= this.maxScopesPerTick ? scopes : this.rotatingWindow(scopes, this.maxScopesPerTick);
      if (scopes.length > carried.length) {
        this.logger.warn(
          `Ledger integrity worker carried ${carried.length} of ${scopes.length} warehouse(s) this tick ` +
            `— the rotating window advances each tick until every warehouse is checked`,
        );
      }
      for (const scope of carried) {
        // …and per scope chain (one long chain is inside the call: 60 min bound, PENDING per-page).
        this.ticks.beat();
        try {
          const summary = await this.inventory.runLedgerIntegrity(scope.tenantId, scope.warehouseId);
          if (summary.anchored > 0 || summary.wormCopied > 0 || summary.baselined) {
            this.logger.log(
              `ledger integrity (tenant ${scope.tenantId}, warehouse ${scope.warehouseId}): ` +
                `${summary.baselined ? `baselined B=${summary.legacyThroughSeq}, ` : ''}${summary.anchored} anchor(s), ${summary.wormCopied} WORM cop(ies)`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Ledger integrity worker failed for warehouse ${scope.warehouseId} (tenant ${scope.tenantId}) ` +
              `— retried next tick: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { carried: carried.length, total: scopes.length };
    } catch (error) {
      this.logger.error(`Ledger integrity cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return { carried: 0, total: 0 };
    } finally {
      this.running = false;
    }
  }

  /** `cap` scopes from the tick offset, wrapping; the offset advances by the number CARRIED (the storage worker's window). */
  private rotatingWindow<T>(ordered: readonly T[], cap: number): T[] {
    const start = this.tickOffset % ordered.length;
    const window: T[] = [];
    for (let i = 0; i < cap && i < ordered.length; i += 1) {
      const scope = ordered[(start + i) % ordered.length];
      if (scope !== undefined) {
        window.push(scope);
      }
    }
    this.tickOffset = (start + window.length) % ordered.length;
    return window;
  }
}

/** `SESSION_PURGE_POLL_MS` (story 6-1a): the session/attempt purge cadence; unset/`0` = OFF. */
export function parseSessionPurgePollMs(raw: string | undefined): number {
  return parsePollMs('SESSION_PURGE_POLL_MS', raw);
}

/**
 * Story 6-1a — purges session rows that ended more than 30 days ago (each
 * tenant's delete in its own RLS-scoped transaction) and stale attempt
 * counters; story 6-1b — and spent sign-in challenges and stale pending
 * authenticator secrets. Env-gated OFF when `SESSION_PURGE_POLL_MS` is unset/`0` (daily
 * in production: 86400000); single-flight; `unref`'d timer.
 */
@Injectable()
export class SessionPurgeWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('SessionPurgeWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
  ) {
    this.pollMs = parseSessionPurgePollMs(process.env.SESSION_PURGE_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) return;
    this.logger.log(`Session purge worker started (every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('session-purge', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // Independent: a failing session purge never stops the counter purge.
      let purged = 0;
      this.ticks.beat(); // Story 6-2c (A3): one beat per purge block
      try {
        purged = await purgeEndedSessions(this.db, this.authDb);
      } catch (error) {
        this.logger.error(`Session purge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.ticks.beat();
      try {
        await purgeAuthCounters(this.db);
      } catch (error) {
        this.logger.error(`Attempt-counter purge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Story 6-1b — its own block: sign-in challenges that expired over a day
      // ago and pending authenticator secrets older than 24 h. Its own tenant
      // discovery, and a try/catch per tenant inside.
      this.ticks.beat();
      try {
        await purgeSecondFactorState(this.db, this.authDb, (tenantId, error) =>
          this.logger.error(
            `Second-factor purge failed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } catch (error) {
        this.logger.error(`Second-factor purge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Story 6-1c — its own block: reset tokens expired or spent over a day
      // ago, per tenant (A19: one beat per tenant inside).
      this.ticks.beat();
      try {
        await purgeResetTokens(
          this.db,
          this.authDb,
          (tenantId, error) =>
            this.logger.error(`Reset-token purge failed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`),
          () => this.ticks.beat(),
        );
      } catch (error) {
        this.logger.error(`Reset-token purge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return purged;
    } finally {
      this.running = false;
    }
  }
}

/**
 * Story 1-6c — the licence expiry sweep worker (the `WaveCutoffSweepWorker`
 * shape). Each tick finds the tenants with an active licence whose
 * `validUntil` falls inside the 60-day warning window and is not yet warned
 * for every state (cross-tenant, read-only, `AUTH_DATABASE`), and calls
 * `LicenceFacade.sweepExpiry(tenantId, today)` — which raises
 * `licence.expiry_upcoming` / `licence.expired` once per term (IST dates).
 * A failing tenant is logged and retried next tick. Env-gated OFF when
 * `LICENCE_EXPIRY_POLL_MS` is unset/`0`; single-flight; `unref`'d timer.
 */
@Injectable()
export class LicenceExpiryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('LicenceExpiryWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Story 6-2a (A1): the timer-started tick, awaited on shutdown. */
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(LicenceFacade) private readonly licences: LicenceFacade,
  ) {
    this.pollMs = parseLicenceExpiryPollMs(process.env.LICENCE_EXPIRY_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Licence expiry worker started (poll every ${this.pollMs}ms)`);
    // Story 6-2c (A3): registered for /health/worker; InFlightTick stamps every tick.
    this.ticks.track('licence-expiry', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  /**
   * Story 6-2a (A1): stop the timer, then await the tick already running —
   * bounded by the shared drain deadline — so the pools it uses close after
   * it, never under it.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle for the IST date `today` (the licence clock's by default); returns the tenants it swept. */
  async tick(today: string = licenceToday()): Promise<string[]> {
    if (this.running) {
      return [];
    }
    this.running = true;
    try {
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId"
          from licences
         where status = 'active' and valid_until is not null
           and valid_until <= ${addIsoDays(today, LICENCE_WARNING_LEAD_DAYS)}::date
           and (upcoming_warned_on is null or expired_warned_on is null)
         order by tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const swept: string[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat(); // Story 6-2c (A3): one beat per tenant
        try {
          await this.licences.sweepExpiry(tenantId, today);
          swept.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Licence expiry sweep failed for tenant ${tenantId} — retried next tick: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return swept;
    } catch (error) {
      this.logger.error(`Licence expiry sweep cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** `ATTACHMENT_SWEEP_POLL_MS` (story 2-5a): the attachment retention sweep's poll; unset/`0` = OFF (recommended `600000`). */
export function parseAttachmentSweepPollMs(raw: string | undefined): number {
  return parsePollMs('ATTACHMENT_SWEEP_POLL_MS', raw);
}

/**
 * Story 2-5a (A10, A11, A22) — the attachment retention sweep. Discovers the
 * tenants with sweepable rows on the read-only BYPASSRLS `AUTH_DATABASE`
 * (the `AuditExportWorker` shape — the `attachments_sweep_discovery_idx
 * (status, created_at)` index), then one `AttachmentsFacade.sweep` per
 * tenant in its own try/catch; every write stays in the module's tenant
 * transactions. Safe in two worker processes: every arm claims `FOR UPDATE
 * SKIP LOCKED` and transitions conditionally (a two-sweeper test pins it).
 */
@Injectable()
export class AttachmentSweepWorker implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('AttachmentSweepWorker');
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly ticks = new InFlightTick();

  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
  ) {
    this.pollMs = parseAttachmentSweepPollMs(process.env.ATTACHMENT_SWEEP_POLL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.pollMs === 0) {
      return; // env-gated off
    }
    this.logger.log(`Attachment sweep started (poll every ${this.pollMs}ms)`);
    this.ticks.track('attachment-sweep', this.pollMs);
    this.timer = setInterval(() => this.ticks.start(() => this.tick()), this.pollMs);
    this.timer.unref?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!(await this.ticks.settle())) {
      this.logger.warn('A tick was still running at the shutdown drain deadline');
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One cycle; returns the tenants it swept. */
  async tick(now: Date = new Date()): Promise<string[]> {
    if (this.running) {
      return []; // shed: one cycle at a time in this process
    }
    this.running = true;
    try {
      const purgeCutoff = new Date(now.getTime() - this.attachments.purgeDays * 86_400_000).toISOString();
      const uploadingCutoff = new Date(now.getTime() - UPLOADING_MAX_AGE_MS).toISOString();
      const tenants = (await this.authDb.execute(sql`
        select distinct tenant_id as "tenantId"
        from attachments
        where (status = 'uploading' and created_at < ${uploadingCutoff})
           or (status in ('staged', 'awaited') and created_at < ${purgeCutoff})
           or (status = 'discarded' and purged_at is null)
           or (status = 'removed' and purged_at is null and object_key is not null and removed_at < ${purgeCutoff})
        order by tenant_id asc
      `)) as unknown as { tenantId: string }[];
      const swept: string[] = [];
      for (const { tenantId } of tenants) {
        this.ticks.beat();
        try {
          const summary = await this.attachments.sweep(tenantId, now);
          const touched =
            summary.discardedUploading + summary.discardedStaged + summary.expired + summary.purged + summary.deleteFailures;
          if (touched > 0) {
            this.logger.log(
              `attachment sweep (tenant ${tenantId}): ${summary.discardedUploading} reservations and ${summary.discardedStaged} unbound photos discarded, ` +
                `${summary.expired} expired, ${summary.purged} purged, ${summary.deleteFailures} delete failures, ${summary.keptReferenced} kept for review`,
            );
          }
          swept.push(tenantId);
        } catch (error) {
          this.logger.error(
            `Attachment sweep failed for tenant ${tenantId} — retried next tick: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return swept;
    } catch (error) {
      this.logger.error(`Attachment sweep cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [
    SharedModule,
    InventoryModule,
    MovementsModule,
    ReplenishmentModule,
    ChannelsModule,
    BillingModule,
    // Story 9-2b — the cutoff sweep (outbound) and the push sender (notifications).
    OutboundModule,
    NotificationsModule,
    // Story 9-3b — the audit export runner (tenancy).
    TenancyModule,
    // Story 1-6c — the licence expiry sweep (compliance).
    ComplianceModule,
    // Story 5-1a — the email sender (mail).
    MailModule,
    // Story 2-5a — the attachment retention sweep (attachments).
    AttachmentsModule,
    // Story 5-2a — the client webhook sender (client-webhooks).
    ClientWebhooksModule,
  ],
  providers: [
    OutboxRelayWorker,
    ReconciliationWorker,
    ReservationReaper,
    CountSchedulerWorker,
    ReplenishmentSchedulerWorker,
    // Story 7-1's T3 — the availability publisher (env-gated OFF by
    // default; the facade carries the cycle, the worker only times it).
    ChannelsSyncWorker,
    // Story 21-4 — the daily storage snapshots (env-gated OFF by default).
    StorageSnapshotWorker,
    // Story 9-2b — the push sender and the wave cutoff sweep (both env-gated OFF by default).
    PushSenderWorker,
    WaveCutoffSweepWorker,
    // Story 9-3b — the async audit export (env-gated OFF by default).
    AuditExportWorker,
    // Story 9-3c — the ledger integrity check (env-gated OFF by default).
    LedgerIntegrityWorker,
    // Story 6-1a — the session / attempt-counter purge (env-gated OFF by default).
    SessionPurgeWorker,
    // Story 1-6c — the licence expiry sweep (env-gated OFF by default).
    LicenceExpiryWorker,
    // Story 5-1a — the email sender (env-gated OFF by default).
    EmailSenderWorker,
    // Story 2-5a — the attachment retention sweep (env-gated OFF by default).
    AttachmentSweepWorker,
    // Story 5-2a — the client webhook sender (env-gated OFF by default).
    WebhookSenderWorker,
    // Story 4-2c — the backorder allocation sweep (env-gated OFF by default).
    BackorderAllocationWorker,
    // Story 6-2c (A10): the worker role's health-only listener (idle in the api role).
    WorkerHealthServer,
  ],
  exports: [],
})
export class JobsModule {}
