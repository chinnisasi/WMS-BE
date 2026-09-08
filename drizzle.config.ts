import { defineConfig } from 'drizzle-kit';
import { requiredDbUrl } from './src/shared/db/db';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/db/schema.ts',
  out: './drizzle',
  // Same rule as the app (db.ts): DATABASE_URL is required everywhere —
  // bun loads .env automatically.
  dbCredentials: {
    url: requiredDbUrl(),
  },
  strict: true,
  verbose: true,
});
