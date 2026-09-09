import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { OUTBOX_RELAY } from '../shared/events/outbox.seam';
import type { OutboxRelay } from '../shared/events/outbox.seam';

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
 * jobs shell — background/relay workers (outbox relay, import batches,
 * notifications dispatch). The event bus + outbox seams live in shared/events
 * and are provided by SharedModule. The relay worker is env-gated OFF unless
 * `OUTBOX_RELAY_POLL_MS` is set (tests exercise `drain()` directly).
 */
@Module({
  imports: [SharedModule],
  providers: [OutboxRelayWorker],
  exports: [],
})
export class JobsModule {}