import { API_PREFIX, createApp, parsePort } from './app.factory';

async function bootstrap(): Promise<void> {
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
