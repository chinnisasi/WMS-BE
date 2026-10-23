import { API_PREFIX, createApp, parsePort } from './app.factory';
import { assertSecondFactorKeyConfigured } from './modules/tenancy/second-factor-secrets';
import { assertMailConfigured } from './modules/mail/mail.config';
import { assertDatabaseTlsConfig } from './shared/db/pg-tls';
import {
  assertApiRunsNoJobs,
  ConfigRefusal,
  EXIT_CONFIG_REFUSAL,
  EXIT_CRASH,
  JOB_POLL_VARIABLES,
  parseProcessRole,
} from './shared/lifecycle/process-role';
import { armForceExit } from './shared/lifecycle/shutdown';
import { markWorkerRegistrationComplete, parseHeartbeatEnv, registeredJobs } from './shared/lifecycle/worker-heartbeat';

/**
 * The boot sequence (story 6-2c). Every refusal is a `ConfigRefusal` and
 * exits 78; anything else that fails the boot exits 1 (A18).
 *
 *   1. the process role (`WMS_PROCESS_ROLE`: api | worker)
 *   2. the heartbeat setting (`WORKER_HEARTBEAT_STALE_MS`, every role)
 *   3. the DB TLS configuration, without connecting (A4)
 *   4. a production API runs no job (A9)
 *   5. the MFA key (story 6-1b) and the mail configuration (story 5-1a)
 *   6. the app: the API listens; the worker initialises with no API
 *      listener (its health-only listener comes up in `init`), refuses when
 *      no job is enabled, then marks its registration complete
 */
/**
 * A SIGTERM during boot (before the shutdown hooks are installed — e.g. while
 * `app.init()` waits on a database) ends the process 0 rather than dying 143
 * mid-boot: nothing has been served, so there is nothing to drain. Removed
 * once Nest's shutdown hooks take over.
 */
function onBootSigterm(): void {
  console.error('SIGTERM during boot — exiting 0 (nothing was serving yet)');
  process.exit(0);
}

async function bootstrap(): Promise<void> {
  process.on('SIGTERM', onBootSigterm);
  const role = parseProcessRole(process.env.WMS_PROCESS_ROLE);
  parseHeartbeatEnv(process.env);
  assertDatabaseTlsConfig(process.env);
  assertApiRunsNoJobs(role, process.env);
  // Story 6-1b — the app refuses to boot without a usable MFA_ENCRYPTION_KEY:
  // without it every owner would be locked out of sign-in on deploy day.
  // Story 5-1a — and without a usable mail configuration when mail is on
  // (`EMAIL_PROVIDER=ses|log` needs EMAIL_FROM, WEB_BASE_URL, EMAIL_SEAL_KEY).
  // Both are configuration refusals: exit 78 (story 6-2c, A18).
  try {
    assertSecondFactorKeyConfigured();
    assertMailConfigured();
  } catch (err) {
    throw new ConfigRefusal(err instanceof Error ? err.message : String(err));
  }
  const app = await createApp(role === 'api');
  if (role === 'worker') {
    await app.init();
    if (registeredJobs().length === 0) {
      throw new ConfigRefusal(
        `WMS_PROCESS_ROLE=worker, but no job is enabled — set at least one of ${JOB_POLL_VARIABLES.join(', ')}`,
      );
    }
    markWorkerRegistrationComplete();
  }
  // Story 6-2a (A1) — SIGTERM / SIGINT run the graceful sequence (drain the
  // workers' ticks and the in-flight requests, close the server, close the
  // pools) and then exit 0; a sequence still running after 25 s is ended by
  // the force exit (exit 75 — story 6-2c, A18), under the orchestrator's
  // 30 s stop timeout.
  armForceExit();
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  process.removeListener('SIGTERM', onBootSigterm);
  const port = parsePort(process.env.PORT);
  if (role === 'worker') {
    // eslint-disable-next-line no-console
    console.log(
      `wms-be worker running ${registeredJobs().map((job) => job.job).join(', ')} — health only on port ${port} ` +
        '(/api/v1/health, /api/v1/health/worker)',
    );
    return;
  }
  const url = await app.getUrl();
  // eslint-disable-next-line no-console
  console.log(`wms-be listening on ${url} (${API_PREFIX}) — port ${port}`);
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document: ${url}/${API_PREFIX}/openapi.json`);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigRefusal) {
    console.error(`Refusing to start: ${err.message}`);
    process.exit(EXIT_CONFIG_REFUSAL);
  }
  console.error(err);
  process.exit(EXIT_CRASH);
});
