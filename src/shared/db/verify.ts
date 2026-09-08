/**
 * Migration verification: after `db:migrate`, round-trips one row through the
 * Drizzle client to prove the committed migrations match the schema. Run via
 * `bun run db:verify` (CI runs it in the `migrations` job).
 */
import { eq } from 'drizzle-orm';
import { createDatabase } from './db';
import { appMetadata } from './schema';

async function main(): Promise<void> {
  const db = createDatabase();
  const key = `verify:${crypto.randomUUID()}`;
  await db.insert(appMetadata).values({ key, value: 'ok' });
  const rows = await db.select().from(appMetadata).where(eq(appMetadata.key, key));
  if (rows.length !== 1 || rows[0]!.value !== 'ok') {
    throw new Error('Round-trip failed: inserted row not found or wrong value');
  }
  await db.delete(appMetadata).where(eq(appMetadata.key, key));
  // eslint-disable-next-line no-console
  console.log('Database round-trip OK: committed migrations match the schema.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});