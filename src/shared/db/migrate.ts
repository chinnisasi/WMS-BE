/**
 * Migration runner (spine conventions): applies pending Drizzle migrations,
 * all timestamps UTC, ids UUIDv7. Run via `bun run db:migrate`.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './db';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const db = createDatabase(url);
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    // eslint-disable-next-line no-console
    console.log('Migrations applied cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

void main();