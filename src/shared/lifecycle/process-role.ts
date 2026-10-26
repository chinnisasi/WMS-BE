/**
 * Story 6-2c — what kind of backend process this is, and the boot refusals
 * that go with it (decision 4, A9, A10, A18).
 *
 * One image runs every backend process (6-2a decision 2); `WMS_PROCESS_ROLE`
 * says which:
 *
 *   api     (the default — unset or empty) the HTTP API on `PORT`
 *   worker  the background jobs, with NO API listener: Nest is initialised
 *           without `listen`, and a health-only `node:http` listener answers
 *           on `PORT` (`worker-health-server.ts`)
 *
 * Every refusal here is a {@link ConfigRefusal}, which `main.ts` maps to
 * exit **78** (EX_CONFIG) — distinct from a crash (1) and the drain-timeout
 * force exit (75), so an orchestrator can tell "do not retry" from "retry".
 */

/** Exit codes (A18). */
export const EXIT_CONFIG_REFUSAL = 78;
export const EXIT_DRAIN_TIMEOUT = 75;
export const EXIT_CRASH = 1;

/** A boot or configuration refusal: `main.ts` (and the DB CLIs) exit 78 on it. */
export class ConfigRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigRefusal';
  }
}

export const PROCESS_ROLES = ['api', 'worker'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** `WMS_PROCESS_ROLE`: unset or empty is `api` (A10); anything but `api`/`worker` refuses. */
export function parseProcessRole(raw: string | undefined): ProcessRole {
  if (raw === undefined || raw === '') return 'api';
  if ((PROCESS_ROLES as readonly string[]).includes(raw)) return raw as ProcessRole;
  throw new ConfigRefusal(`WMS_PROCESS_ROLE must be one of ${PROCESS_ROLES.join(', ')} (got "${raw}")`);
}

/**
 * The fourteen job switches (`jobs.module.ts`), each env-gated by its own
 * `*_POLL_MS` (unset or `0` = off).
 */
export const JOB_POLL_VARIABLES = [
  'OUTBOX_RELAY_POLL_MS',
  'OUTBOX_RECONCILE_POLL_MS',
  'RESERVATION_REAPER_POLL_MS',
  'COUNT_SCHEDULER_POLL_MS',
  'REPLENISHMENT_SCHEDULER_POLL_MS',
  'CHANNELS_SYNC_POLL_MS',
  'STORAGE_SNAPSHOT_POLL_MS',
  'PUSH_SENDER_POLL_MS',
  'WAVE_CUTOFF_SWEEP_POLL_MS',
  'AUDIT_EXPORT_POLL_MS',
  'LEDGER_INTEGRITY_POLL_MS',
  'SESSION_PURGE_POLL_MS',
  'LICENCE_EXPIRY_POLL_MS',
  'EMAIL_SEND_POLL_MS',
  'ATTACHMENT_SWEEP_POLL_MS',
] as const;

/** The job switches set to anything other than off (unset, empty or a numeric 0). */
export function enabledJobPollVariables(env: NodeJS.ProcessEnv): string[] {
  return JOB_POLL_VARIABLES.filter((name) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return false;
    return Number(raw) !== 0;
  });
}

/**
 * A9 — a production API task runs no job. With the role split, a `*_POLL_MS`
 * left on the API task would run that job once per API task beside the
 * worker's (seven jobs are not proven safe to run twice — DEPLOY.md §1).
 * `WMS_API_RUNS_JOBS=1` is the explicit opt-in for a single-process
 * deployment; outside production (dev, tests) nothing changes.
 */
export function assertApiRunsNoJobs(role: ProcessRole, env: NodeJS.ProcessEnv): void {
  if (role !== 'api' || env.NODE_ENV !== 'production' || env.WMS_API_RUNS_JOBS === '1') return;
  const enabled = enabledJobPollVariables(env);
  if (enabled.length > 0) {
    throw new ConfigRefusal(
      `WMS_PROCESS_ROLE=api in production runs no background job, but ${enabled.join(', ')} ` +
        `${enabled.length === 1 ? 'is' : 'are'} set — run the jobs on the worker task (WMS_PROCESS_ROLE=worker), ` +
        'or set WMS_API_RUNS_JOBS=1 to run them in this process on purpose',
    );
  }
}

/** `PORT`: an integer 1–65535, default 3000; anything else refuses the boot (78). */
export function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigRefusal(`Invalid PORT "${raw ?? ''}" — must be an integer between 1 and 65535`);
  }
  return port;
}
