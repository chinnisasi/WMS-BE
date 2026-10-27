import { ConfigRefusal } from './process-role';

/**
 * Story 6-2c — the worker heartbeat (decision 5 as amended by A3).
 *
 * In process, never in Valkey: the health check judges THIS task's loops (a
 * shared key could be fresh from another task), and Valkey being down must
 * not restart the worker (the C28 shared-dependency rule).
 *
 * Each enabled job registers here through `InFlightTick.track` (its
 * `onApplicationBootstrap`, after its env gate). `InFlightTick` stamps — never
 * the worker's own `tick()`, so every early return (the `running` shed, a
 * lock not acquired, a flag off) still counts:
 *
 *   lastStartedAt   when a tick starts
 *   lastSettledAt   when a tick settles
 *   lastProgressAt  on start, on every `beat()`, and on settle
 *
 * A job is STALE when either
 *   (a) loop dead:    no tick in flight and now − max(lastStartedAt,
 *                     lastSettledAt) > pollMs + 60 s (measured from
 *                     registration before the first tick) — from the settle
 *                     too, so a long tick that just ended does not read dead
 *                     until the next fire; or
 *   (b) no progress:  a tick in flight and now − lastProgressAt > noProgressMs.
 *
 * It signals loop liveness only: a tick that throws still settles; errors
 * stay in the logs (6.3's alarms).
 */

/** Rule (a)'s slack past one poll interval. */
export const LOOP_DEAD_SLACK_MS = 60_000;

/** The smallest `WORKER_HEARTBEAT_STALE_MS` accepted (A3). */
export const MIN_HEARTBEAT_STALE_MS = 60_000;

/** The sixteen jobs (5-1a added email-sender, 2-5a attachment-sweep, 5-2a webhook-sender), by the names `/health/worker` reports. */
export const WORKER_JOBS = [
  'outbox-relay',
  'reconciliation',
  'reservation-reaper',
  'count-scheduler',
  'replenishment-scheduler',
  'channels-sync',
  'storage-snapshot',
  'push-sender',
  'wave-cutoff-sweep',
  'audit-export',
  'ledger-integrity',
  'session-purge',
  'licence-expiry',
  'email-sender',
  // Story 2-5a — the attachment retention sweep.
  'attachment-sweep',
  // Story 5-2a — the client webhook sender.
  'webhook-sender',
] as const;
export type WorkerJob = (typeof WORKER_JOBS)[number];

const MINUTE = 60_000;

/**
 * Rule (b)'s default bound per job (the spec's Design Notes table). Above the
 * ~13 minutes a hung Postgres socket takes to surface an error (postgres.js
 * keep_alive 60 s, then 9 × 75 s Linux keepalive probes), so one hung socket
 * is a logged error and a recovery, not a restart. audit-export and
 * ledger-integrity beat per tenant / per scope only — one export or one chain
 * can run long inside a facade call — so they get 60 minutes (a per-page beat
 * needs a seam across the module boundary: PENDING).
 */
export const DEFAULT_NO_PROGRESS_MS: Readonly<Record<WorkerJob, number>> = {
  'outbox-relay': 20 * MINUTE,
  reconciliation: 20 * MINUTE,
  'reservation-reaper': 20 * MINUTE,
  'count-scheduler': 20 * MINUTE,
  'replenishment-scheduler': 20 * MINUTE,
  'channels-sync': 20 * MINUTE,
  'storage-snapshot': 20 * MINUTE,
  'push-sender': 20 * MINUTE,
  'wave-cutoff-sweep': 20 * MINUTE,
  'audit-export': 60 * MINUTE,
  'ledger-integrity': 60 * MINUTE,
  'session-purge': 20 * MINUTE,
  'licence-expiry': 20 * MINUTE,
  'email-sender': 20 * MINUTE,
  'attachment-sweep': 20 * MINUTE,
  // Story 5-2a (A8) — a tick's sends stop at its 60 s budget and beat per
  // send; 2 minutes is above one budget plus one 30 s timeout.
  'webhook-sender': 2 * MINUTE,
};

/** The heartbeat clock — assigned by tests (the `rateCardClock` precedent), never spied. */
export const heartbeatClock = { now: (): number => Date.now() };

/**
 * `WORKER_HEARTBEAT_STALE_MS`, parsed in every role (A10): unset or empty is
 * "no override"; otherwise an integer ≥ 60 000, which raises every job's
 * no-progress bound to at least its value. Anything else refuses the boot.
 */
export function parseHeartbeatEnv(env: NodeJS.ProcessEnv): { staleMs: number | undefined } {
  const raw = env.WORKER_HEARTBEAT_STALE_MS;
  if (raw === undefined || raw.trim() === '') return { staleMs: undefined };
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(parsed) || parsed < MIN_HEARTBEAT_STALE_MS) {
    throw new ConfigRefusal(
      `WORKER_HEARTBEAT_STALE_MS must be an integer of milliseconds ≥ ${MIN_HEARTBEAT_STALE_MS} (got "${raw}")`,
    );
  }
  return { staleMs: parsed };
}

/** A job's effective no-progress bound: its default, raised by the override. */
export function noProgressBound(defaultMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const { staleMs } = parseHeartbeatEnv(env);
  return staleMs === undefined ? defaultMs : Math.max(defaultMs, staleMs);
}

/** One registered job's heartbeat. Mutated only by `InFlightTick`. */
export interface JobHeartbeat {
  readonly job: string;
  readonly pollMs: number;
  readonly noProgressMs: number;
  readonly registeredAt: number;
  inFlight: boolean;
  lastStartedAt: number | null;
  lastSettledAt: number | null;
  lastProgressAt: number;
}

const registry = new Map<string, JobHeartbeat>();
let registrationComplete = false;

/**
 * Registers (or re-registers) a job. A later registration under the same name
 * replaces the earlier one — a process boots one app, a test suite many.
 */
export function registerJobHeartbeat(job: string, pollMs: number, noProgressMs: number): JobHeartbeat {
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error(`job ${job}: pollMs must be a positive integer (got ${pollMs})`);
  if (!Number.isInteger(noProgressMs) || noProgressMs <= 0) {
    throw new Error(`job ${job}: noProgressMs must be a positive integer (got ${noProgressMs})`);
  }
  const now = heartbeatClock.now();
  const entry: JobHeartbeat = {
    job,
    pollMs,
    noProgressMs,
    registeredAt: now,
    inFlight: false,
    lastStartedAt: null,
    lastSettledAt: null,
    lastProgressAt: now,
  };
  registry.set(job, entry);
  return entry;
}

/** The registered jobs, in registration order. */
export function registeredJobs(): readonly JobHeartbeat[] {
  return [...registry.values()];
}

/** Why a job is stale, or null when it is fresh. */
export function staleReason(entry: JobHeartbeat, now: number): 'loop-dead' | 'no-progress' | null {
  if (entry.inFlight) {
    return now - entry.lastProgressAt > entry.noProgressMs ? 'no-progress' : null;
  }
  const since = Math.max(entry.lastStartedAt ?? entry.registeredAt, entry.lastSettledAt ?? entry.registeredAt);
  return now - since > entry.pollMs + LOOP_DEAD_SLACK_MS ? 'loop-dead' : null;
}

/** The stale jobs' names at `now`. */
export function staleJobs(now: number = heartbeatClock.now()): string[] {
  return registeredJobs()
    .filter((entry) => staleReason(entry, now) !== null)
    .map((entry) => entry.job);
}

/**
 * Set by `main.ts` once the worker's app has initialised and the no-jobs
 * check passed; until then `/health/worker` answers 503 `not-ready` (A10).
 */
export function markWorkerRegistrationComplete(): void {
  registrationComplete = true;
}

export function isWorkerRegistrationComplete(): boolean {
  return registrationComplete;
}

/** Test seam: forget every job and the registration flag. */
export function resetWorkerHeartbeats(): void {
  registry.clear();
  registrationComplete = false;
}
