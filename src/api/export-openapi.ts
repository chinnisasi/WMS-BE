/**
 * Exports the versioned OpenAPI document to disk (openapi/openapi.json).
 * Run via `bun run openapi:export`; wms-fe's generated client is built from
 * this artifact (AD-8).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.factory';
import { OpenApiDocumentHolder } from './openapi-document.holder';

async function main(): Promise<void> {
  const app = await createApp(false);
  const holder = app.get(OpenApiDocumentHolder);
  const outPath = resolve(process.cwd(), 'openapi/openapi.json');
  writeFileSync(outPath, JSON.stringify(holder.get(), null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document written to ${outPath}`);
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});