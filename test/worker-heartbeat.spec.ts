import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutboxRelayWorker, StorageSnapshotWorker } from '../src/jobs/jobs.module';
import type { BillingFacade } from '../src/modules/billing/billing.facade';
import type { Database } from '../src/shared/db/db';
import type { OutboxRelay } from '../src/shared/events/outbox.seam';
import { ConfigRefusal } from '../src/shared/lifecycle/process-role';
import { InFlightTick, resetShutdownDrainDeadline } from '../src/shared/lifecycle/shutdown';
import {
  DEFAULT_NO_PROGRESS_MS,
  heartbeatClock,
  LOOP_DEAD_SLACK_MS,
  noProgressBound,
  parseHeartbeatEnv,
  registeredJobs,
  resetWorkerHeartbeats,
  staleJobs,
  staleReason,
  WORKER_JOBS,
} from '../src/shared/lifecycle/worker-heartbeat';

/**
 * Story 6-2c (A3) — the worker heartbeat: staleness means "no progress".
 *
 *   (a) loop dead:   no tick in flight and now − lastStartedAt > pollMs + 60 s
 *   (b) no progress: a tick in flight and now − lastProgressAt > noProgressMs
 *
 * The clock is `heartbeatClock` (assigned, never spied — jest's
 * restoreMocks); ticks are driven through `InFlightTick` exactly as the
 * workers' timers drive them.
 */
const MINUTE = 60_000;
const realNow = heartbeatClock.now;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the worker heartbeat (story 6-2c, A3)', () => {
  let now = 0;

  beforeEach(() => {
    resetWorkerHeartbeats();
    now = 1_000_000;
    heartbeatClock.now = () => now;
    delete process.env.WORKER_HEARTBEAT_STALE_MS;
  });

  afterEach(() => {
    heartbeatClock.now = realNow;
    resetWorkerHeartbeats();
    resetShutdownDrainDeadline();
    delete process.env.WORKER_HEARTBEAT_STALE_MS;
  });

  describe('parse (WORKER_HEARTBEAT_STALE_MS)', () => {
    it('unset or empty: no override', () => {
      expect(parseHeartbeatEnv({})).toEqual({ staleMs: undefined });
      expect(parseHeartbeatEnv({ WORKER_HEARTBEAT_STALE_MS: '' })).toEqual({ staleMs: undefined });
    });

    it('an integer ≥ 60000 is accepted', () => {
      expect(parseHeartbeatEnv({ WORKER_HEARTBEAT_STALE_MS: '60000' })).toEqual({ staleMs: 60_000 });
      expect(parseHeartbeatEnv({ WORKER_HEARTBEAT_STALE_MS: '900000' })).toEqual({ staleMs: 900_000 });
    });

    it.each(['59999', '0', '-60000', 'abc', '1e6', '90000.5', ' '.repeat(0) + '60000ms'])('"%s" refuses the boot (ConfigRefusal → 78)', (raw) => {
      expect(() => parseHeartbeatEnv({ WORKER_HEARTBEAT_STALE_MS: raw })).toThrow(ConfigRefusal);
      expect(() => parseHeartbeatEnv({ WORKER_HEARTBEAT_STALE_MS: raw })).toThrow(/WORKER_HEARTBEAT_STALE_MS/);
    });

    it('the override RAISES a bound, never lowers it', () => {
      expect(noProgressBound(20 * MINUTE, {})).toBe(20 * MINUTE);
      expect(noProgressBound(20 * MINUTE, { WORKER_HEARTBEAT_STALE_MS: String(90 * MINUTE) })).toBe(90 * MINUTE);
      expect(noProgressBound(60 * MINUTE, { WORKER_HEARTBEAT_STALE_MS: String(15 * MINUTE) })).toBe(60 * MINUTE);
    });

    it('the default bounds: 20 min, 60 min for audit-export and ledger-integrity, one entry per job', () => {
      expect(Object.keys(DEFAULT_NO_PROGRESS_MS).sort()).toEqual([...WORKER_JOBS].sort());
      for (const job of WORKER_JOBS) {
        expect(DEFAULT_NO_PROGRESS_MS[job]).toBe(job === 'audit-export' || job === 'ledger-integrity' ? 60 * MINUTE : 20 * MINUTE);
      }
    });

    it('track applies the override to the registered bound', () => {
      process.env.WORKER_HEARTBEAT_STALE_MS = String(45 * MINUTE);
      new InFlightTick().track('push-sender', 5_000);
      expect(registeredJobs()[0]).toMatchObject({ job: 'push-sender', pollMs: 5_000, noProgressMs: 45 * MINUTE });
    });
  });

  describe('rule (a): loop dead', () => {
    it('before the first tick it is measured from registration: fresh at pollMs + 60 s, stale 1 ms later', () => {
      new InFlightTick().track('outbox-relay', 2_000);
      const registered = now;
      expect(staleJobs(registered + 2_000 + LOOP_DEAD_SLACK_MS)).toEqual([]);
      expect(staleJobs(registered + 2_000 + LOOP_DEAD_SLACK_MS + 1)).toEqual(['outbox-relay']);
    });

    it('a cleared timer goes stale at pollMs + 60 s after the last tick SETTLED', async () => {
      const ticks = new InFlightTick();
      ticks.track('session-purge', 86_400_000);
      now += 10_000;
      const startedAt = now;
      ticks.start(async () => undefined);
      now += 5_000; // the tick takes 5 s, then settles
      await flush();
      const [entry] = registeredJobs();
      const settledAt = startedAt + 5_000;
      expect(entry).toMatchObject({ inFlight: false, lastStartedAt: startedAt, lastSettledAt: settledAt, lastProgressAt: settledAt });
      // No further tick ever starts (the timer is gone).
      expect(staleReason(entry!, settledAt + 86_400_000 + LOOP_DEAD_SLACK_MS)).toBeNull();
      expect(staleReason(entry!, settledAt + 86_400_000 + LOOP_DEAD_SLACK_MS + 1)).toBe('loop-dead');
    });

    it('a beating 20-minute tick that settles stays fresh — it does not read loop-dead the moment it ends', async () => {
      const ticks = new InFlightTick();
      ticks.track('replenishment-scheduler', 60_000);
      const release = deferred();
      ticks.start(() => release.promise);
      for (let unit = 0; unit < 40; unit += 1) {
        now += 30_000;
        ticks.beat();
      }
      release.resolve();
      await flush();
      const settledAt = now;
      expect(staleJobs(settledAt)).toEqual([]);
      expect(staleJobs(settledAt + 60_000 + LOOP_DEAD_SLACK_MS)).toEqual([]);
      expect(staleJobs(settledAt + 60_000 + LOOP_DEAD_SLACK_MS + 1)).toEqual(['replenishment-scheduler']);
    });

    it('an hourly job is fresh for the hour after a long tick settles (no restart storm)', async () => {
      const ticks = new InFlightTick();
      ticks.track('count-scheduler', 3_600_000);
      const release = deferred();
      ticks.start(() => release.promise);
      for (let unit = 0; unit < 9; unit += 1) {
        now += 10 * MINUTE; // 90 minutes in all — longer than pollMs + 60 s
        ticks.beat();
      }
      release.resolve();
      await flush();
      const settledAt = now;
      for (let minute = 0; minute <= 61; minute += 1) expect(staleJobs(settledAt + minute * MINUTE)).toEqual([]);
      expect(staleJobs(settledAt + 3_600_000 + LOOP_DEAD_SLACK_MS + 1)).toEqual(['count-scheduler']);
    });

    it('lock not acquired → still fresh: the relay tick that sheds (drain answers [], the advisory-lock shed) stamps like any other', async () => {
      process.env.OUTBOX_RELAY_POLL_MS = '20';
      const drain = jest.fn().mockResolvedValue([]); // `pg_try_advisory_lock` not acquired: the cycle sheds, publishes nothing
      const worker = new OutboxRelayWorker({ drain } as unknown as OutboxRelay);
      delete process.env.OUTBOX_RELAY_POLL_MS;
      heartbeatClock.now = realNow; // real timers drive the worker's interval
      worker.onApplicationBootstrap();
      try {
        const deadline = Date.now() + 5_000;
        while (drain.mock.calls.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(drain.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        await worker.beforeApplicationShutdown();
      }
      const [entry] = registeredJobs();
      expect(entry?.job).toBe('outbox-relay');
      // Every shed tick stamped: the last start is a recent tick, not the registration.
      expect(entry!.lastStartedAt).not.toBeNull();
      expect(entry!.lastStartedAt!).toBeGreaterThan(entry!.registeredAt);
      expect(staleJobs(entry!.lastStartedAt! + 20 + LOOP_DEAD_SLACK_MS)).toEqual([]);
    });

    it('a tick that throws still settles and stamps (errors are the logs\' business, not the heartbeat\'s)', async () => {
      const ticks = new InFlightTick();
      ticks.track('reconciliation', 2_000);
      ticks.start(() => Promise.reject(new Error('cycle failed')));
      await flush();
      const [entry] = registeredJobs();
      expect(entry).toMatchObject({ inFlight: false, lastStartedAt: now, lastProgressAt: now });
      ticks.start(() => {
        throw new Error('thrown synchronously');
      });
      await flush();
      expect(registeredJobs()[0]?.inFlight).toBe(false);
    });
  });

  describe('rule (b): no progress', () => {
    it('a hung tick (never settles, never beats) goes stale at its bound — and not before', () => {
      const ticks = new InFlightTick();
      ticks.track('channels-sync', 60_000);
      const startedAt = now;
      ticks.start(() => new Promise(() => undefined));
      const [entry] = registeredJobs();
      expect(entry!.inFlight).toBe(true);
      expect(staleJobs(startedAt + 20 * MINUTE)).toEqual([]);
      expect(staleJobs(startedAt + 20 * MINUTE + 1)).toEqual(['channels-sync']);
      expect(staleReason(entry!, startedAt + 20 * MINUTE + 1)).toBe('no-progress');
    });

    it('a 20-minute tick that beats per unit stays healthy; when the beats stop it goes stale one bound after the last', async () => {
      const ticks = new InFlightTick();
      ticks.track('storage-snapshot', 300_000);
      const release = deferred();
      ticks.start(() => release.promise);
      // 40 units of 30 s each — a 20-minute tick, well past 3 × pollMs.
      for (let unit = 0; unit < 40; unit += 1) {
        now += 30_000;
        ticks.beat();
        expect(staleJobs(now)).toEqual([]);
      }
      const lastBeat = now;
      expect(staleJobs(lastBeat + 20 * MINUTE)).toEqual([]);
      expect(staleJobs(lastBeat + 20 * MINUTE + 1)).toEqual(['storage-snapshot']);
      release.resolve();
      await flush();
      // Settled: back to rule (a), measured from the tick's start.
      expect(registeredJobs()[0]?.inFlight).toBe(false);
    });

    it('beat() is a no-op when untracked or idle', () => {
      const untracked = new InFlightTick();
      expect(() => untracked.beat()).not.toThrow();
      const ticks = new InFlightTick();
      ticks.track('licence-expiry', 3_600_000);
      const before = registeredJobs()[0]!.lastProgressAt;
      now += 1_000;
      ticks.beat(); // no tick in flight
      expect(registeredJobs()[0]!.lastProgressAt).toBe(before);
    });

    it('a shed start (a tick still in flight) does not reset the in-flight tick\'s progress', () => {
      const ticks = new InFlightTick();
      ticks.track('push-sender', 5_000);
      const startedAt = now;
      ticks.start(() => new Promise(() => undefined));
      now += 10 * MINUTE;
      ticks.start(async () => undefined); // the interval fires: shed
      expect(registeredJobs()[0]).toMatchObject({ inFlight: true, lastStartedAt: startedAt, lastSettledAt: null, lastProgressAt: startedAt });
    });
  });

  describe('the workers', () => {
    it('StorageSnapshotWorker\'s real tick beats per tenant and per scope: fresh through units each longer than the bound', async () => {
      process.env.STORAGE_SNAPSHOT_POLL_MS = '3600000'; // the timer never fires in the test
      const UNIT_MS = 20 * MINUTE + 1; // each unit alone outlasts the no-progress bound
      const seen: { stale: string[]; progressIsNow: boolean }[] = [];
      const observe = () => {
        seen.push({ stale: staleJobs(now), progressIsNow: registeredJobs()[0]!.lastProgressAt === now });
        now += UNIT_MS;
      };
      const authDb = { execute: async () => [{ tenantId: 't1' }, { tenantId: 't2' }] } as unknown as Database;
      const billing = {
        snapshotScopesOf: async (tenantId: string) => {
          observe();
          return [
            { tenantId, clientId: `${tenantId}-c1`, warehouseId: 'w1' },
            { tenantId, clientId: `${tenantId}-c2`, warehouseId: 'w1' },
          ];
        },
        snapshotScope: async () => {
          observe();
        },
      } as unknown as BillingFacade;
      const worker = new StorageSnapshotWorker(authDb, billing);
      delete process.env.STORAGE_SNAPSHOT_POLL_MS;
      worker.onApplicationBootstrap();
      try {
        const ticks = (worker as unknown as { ticks: InFlightTick }).ticks;
        ticks.start(() => worker.tick(now));
        const deadline = Date.now() + 5_000;
        while (registeredJobs()[0]!.inFlight && Date.now() < deadline) await flush();
      } finally {
        await worker.beforeApplicationShutdown();
      }
      expect(seen).toHaveLength(6); // 2 tenant listings + 4 scopes
      expect(seen.map((unit) => unit.stale)).toEqual(seen.map(() => [])); // fresh at every unit
      expect(seen.every((unit) => unit.progressIsNow)).toBe(true); // each unit's beat is that unit's time
      expect(registeredJobs()[0]!.inFlight).toBe(false);
    });

    const source = readFileSync(join(__dirname, '..', 'src', 'jobs', 'jobs.module.ts'), 'utf8');

    it('each of the 13 jobs is tracked under its own name, after its env gate', () => {
      const tracked = [...source.matchAll(/this\.ticks\.track\('([a-z-]+)', this\.pollMs\)/g)].map((m) => m[1]);
      expect(tracked.sort()).toEqual([...WORKER_JOBS].sort());
    });

    it('every worker whose tick loops over units beats per unit (the Design Notes table)', () => {
      const classes = source.split(/\n@Injectable\(\)\nexport class /).slice(1);
      const beating = classes
        .filter((body) => body.includes('this.ticks.beat()'))
        .map((body) => body.slice(0, body.indexOf(' ')));
      expect(beating.sort()).toEqual(
        [
          'AuditExportWorker',
          'ChannelsSyncWorker',
          'CountSchedulerWorker',
          'LedgerIntegrityWorker',
          'LicenceExpiryWorker',
          'PushSenderWorker',
          'ReplenishmentSchedulerWorker',
          'SessionPurgeWorker',
          'StorageSnapshotWorker',
          'WaveCutoffSweepWorker',
        ].sort(),
      );
    });
  });
});
