import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Single shared Drizzle client. DATABASE_URL is required in every environment;
 * migrations and the app talk to Postgres over UTC-session connections.
 */
export function createDatabase(url: string = requiredDbUrl()): Database {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

function requiredDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (ISO-8601-UTC Postgres session conventions apply)');
  }
  return url;
}