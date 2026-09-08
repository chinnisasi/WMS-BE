import { createApp, API_PREFIX } from './app.factory';

async function bootstrap(): Promise<void> {
  const app = await createApp(true);
  const url = await app.getUrl();
  const port = process.env.PORT ?? 3000;
  // eslint-disable-next-line no-console
  console.log(`wms-be listening on ${url} (${API_PREFIX}) — port ${port}`);
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document: ${url}/${API_PREFIX}/openapi.json`);
}

void bootstrap();