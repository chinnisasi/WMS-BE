import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { OUTBOX_RELAY } from '../shared/events/outbox.seam';
import type { OutboxRelay } from '../shared/events/outbox.seam';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { InventoryFacade } from '../modules/inventory/inventory.facade';

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
 * jobs shell — background/relay workers (outbox relay, reconciliation,
 * reservation reaper, import batches, notifications dispatch). The event bus
 * + outbox seams live in shared/events and are provided by SharedModule. All
 * workers are env-gated OFF unless `OUTBOX_RELAY_POLL_MS` /
 * `OUTBOX_RECONCILE_POLL_MS` / `RESERVATION_REAPER_POLL_MS` is set (tests
 * exercise `drain()` / `reconcileNext()` / `expireDueReservations()` directly).
 */
@Module({
  imports: [SharedModule, InventoryModule],
  providers: [OutboxRelayWorker, ReconciliationWorker, ReservationReaper],
  exports: [],
})
export class JobsModule {}
