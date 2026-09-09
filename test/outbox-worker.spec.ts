import { OutboxRelayWorker, parseOutboxPollMs } from '../src/jobs/jobs.module';
import { outboxBackoffMs } from '../src/shared/events/outbox';
import type { OutboxMessage, OutboxRelay } from '../src/shared/events/outbox.seam';

const ENV_KEY = 'OUTBOX_RELAY_POLL_MS';

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds (jest's own waits are not imported here). */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition never became true');
    }
    await delay(5);
  }
}

/**
 * A relay stub that records drains and can hold the in-flight cycle open so
 * the worker's shed path is observable.
 */
class StubRelay implements OutboxRelay {
  calls: number[] = [];
  private held: ((message: readonly OutboxMessage[]) => void) | undefined;

  /** When true, drain() blocks until `release()`. */
  hold = false;

  async drain(limit: number): Promise<readonly OutboxMessage[]> {
    this.calls.push(limit);
    if (this.hold && this.held === undefined) {
      await new Promise<readonly OutboxMessage[]>((resolve) => {
        this.held = resolve;
      });
      return [];
    }
    return [];
  }

  release(): void {
    this.held?.([]);
    this.held = undefined;
  }
}

describe('outbox relay worker plumbing (unit, story outbox-relay)', () => {
  afterEach(() => {
    setEnv(undefined);
  });

  describe('parseOutboxPollMs', () => {
    it('unset and empty are off (0)', () => {
      expect(parseOutboxPollMs(undefined)).toBe(0);
      expect(parseOutboxPollMs('')).toBe(0);
    });

    it('non-negative integers pass through (0 included)', () => {
      expect(parseOutboxPollMs('2000')).toBe(2000);
      expect(parseOutboxPollMs('0')).toBe(0);
    });

    it('anything not a non-negative integer fails the boot loudly', () => {
      expect(() => parseOutboxPollMs('soon')).toThrow(/OUTBOX_RELAY_POLL_MS/);
      expect(() => parseOutboxPollMs('1.5')).toThrow(/OUTBOX_RELAY_POLL_MS/);
      expect(() => parseOutboxPollMs('-5')).toThrow(/OUTBOX_RELAY_POLL_MS/);
    });
  });

  describe('outboxBackoffMs (the 2^(attempts-1)·5s, 5min-capped ladder)', () => {
    it('first failures double', () => {
      expect(outboxBackoffMs(1)).toBe(5_000);
      expect(outboxBackoffMs(2)).toBe(10_000);
      expect(outboxBackoffMs(4)).toBe(40_000);
    });

    it('caps at 5 minutes', () => {
      expect(outboxBackoffMs(6)).toBe(160_000); // 5s · 2^5, still under the cap
      expect(outboxBackoffMs(7)).toBe(300_000);
      expect(outboxBackoffMs(50)).toBe(300_000);
    });
  });

  describe('OutboxRelayWorker', () => {
    it('an invalid env fails the constructor (loud boot, not a silent worker)', () => {
      const stub = new StubRelay();
      for (const bad of ['soon', '1.5', '-5']) {
        setEnv(bad);
        expect(() => new OutboxRelayWorker(stub)).toThrow(/OUTBOX_RELAY_POLL_MS/);
      }
    });

    it('pollMs=0 (env unset) schedules nothing', async () => {
      setEnv(undefined);
      const stub = new StubRelay();
      const worker = new OutboxRelayWorker(stub);
      worker.onApplicationBootstrap();
      await delay(60);
      expect(stub.calls).toHaveLength(0);
      worker.onApplicationShutdown();
    });

    it('bootstrap with a poll interval drains on the timer', async () => {
      setEnv('20');
      const stub = new StubRelay();
      const worker = new OutboxRelayWorker(stub);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => stub.calls.length >= 2);
        expect(stub.calls[0]).toBe(100); // DEFAULT_OUTBOX_DRAIN_LIMIT
      } finally {
        worker.onApplicationShutdown();
      }
    });

    it('an in-flight cycle sheds the next ticks until it settles', async () => {
      setEnv('15');
      const stub = new StubRelay();
      stub.hold = true;
      const worker = new OutboxRelayWorker(stub);
      worker.onApplicationBootstrap();
      try {
        await waitFor(() => stub.calls.length === 1);
        // Several ticks elapse while the first cycle is still in flight.
        await delay(60);
        expect(stub.calls).toHaveLength(1);
        stub.release();
        await waitFor(() => stub.calls.length >= 2);
      } finally {
        stub.release();
        worker.onApplicationShutdown();
      }
    });

    it('shutdown clears the timer (no further drains)', async () => {
      setEnv('15');
      const stub = new StubRelay();
      const worker = new OutboxRelayWorker(stub);
      worker.onApplicationBootstrap();
      await waitFor(() => stub.calls.length >= 1);
      worker.onApplicationShutdown();
      const atShutdown = stub.calls.length;
      await delay(80);
      expect(stub.calls.length).toBe(atShutdown);
    });
  });
});