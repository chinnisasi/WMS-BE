import { API_PREFIX, createApp, parsePort } from './app.factory';
import { assertSecondFactorKeyConfigured } from './modules/tenancy/second-factor-secrets';
import { assertMailConfigured } from './modules/mail/mail.config';
import { armForceExit } from './shared/lifecycle/shutdown';

async function bootstrap(): Promise<void> {
  // Story 6-1b — the app refuses to boot without a usable MFA_ENCRYPTION_KEY:
  // without it every owner would be locked out of sign-in on deploy day.
  assertSecondFactorKeyConfigured();
  // Story 5-1a — and without a usable mail configuration when mail is on
  // (`EMAIL_PROVIDER=ses|log` needs EMAIL_FROM, WEB_BASE_URL, EMAIL_SEAL_KEY).
  assertMailConfigured();
  const app = await createApp(true);
  // Story 6-2a (A1) — SIGTERM / SIGINT run the graceful sequence (drain the
  // workers' ticks and the in-flight requests, close the server, close the
  // pools) and then exit 0; a sequence still running after 25 s is ended by
  // the force exit (exit 1), under the orchestrator's 30 s stop timeout.
  armForceExit();
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  const url = await app.getUrl();
  const port = parsePort(process.env.PORT);
  // eslint-disable-next-line no-console
  console.log(`wms-be listening on ${url} (${API_PREFIX}) — port ${port}`);
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document: ${url}/${API_PREFIX}/openapi.json`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
