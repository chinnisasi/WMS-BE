import { API_PREFIX, createApp, parsePort } from './app.factory';
import { assertSecondFactorKeyConfigured } from './modules/tenancy/second-factor-secrets';

async function bootstrap(): Promise<void> {
  // Story 6-1b — the app refuses to boot without a usable MFA_ENCRYPTION_KEY:
  // without it every owner would be locked out of sign-in on deploy day.
  assertSecondFactorKeyConfigured();
  const app = await createApp(true);
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
