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

/**
 * DI-friendly wrapper (first wired consumer: SharedModule's `DATABASE`
 * provider). Connection setup is deferred to the first actual query so that
 * booting the app — OpenAPI export, contract tests — never requires
 * DATABASE_URL; only touching Postgres does.
 */
export function createLazyDatabase(): Database {
  return lazyDatabaseProxy(() => createDatabase());
}

/**
 * Auth-time connection (review loop 1 decision): sign-in and the registration
 * replay lookup run before any tenant context exists, so the fail-closed RLS
 * policies would hide every row from the scoped (non-superuser) app role.
 * This client reads through a dedicated connection whose role carries
 * BYPASSRLS — `DATABASE_AUTH_URL` when set, `DATABASE_URL` otherwise. It is
 * for auth-time reads only; every tenant-scoped path stays on `DATABASE`.
 */
export function createLazyAuthDatabase(): Database {
  return lazyDatabaseProxy(() =>
    createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl()),
  );
}

function lazyDatabaseProxy(create: () => Database): Database {
  let instance: Database | undefined;
  const resolved = (): Database => (instance ??= create());

  // Promise-protocol / introspection probes (NestJS checks `then` on every
  // provider at boot, lifecycle hook names at init/shutdown) must not trigger
  // connection setup.
  const INERT = new Set([
    'then',
    'catch',
    'finally',
    'constructor',
    'prototype',
    '__proto__',
    'onModuleInit',
    'onModuleDestroy',
    'onApplicationBootstrap',
    'onApplicationShutdown',
    'beforeApplicationShutdown',
  ]);

  type Mutable = Record<string | symbol, unknown>;
  return new Proxy({} as unknown as Database, {
    get(_target, prop) {
      if (typeof prop !== 'string' || INERT.has(prop)) return undefined;
      const db = resolved() as unknown as Mutable;
      const value = Reflect.get(db, prop, db);
      // Bind prototype methods (select, transaction, …) to the resolved
      // instance; own properties like `$client` (the postgres client —
      // itself a callable with its own methods) pass through untouched.
      if (typeof value === 'function' && !Object.prototype.hasOwnProperty.call(db, prop)) {
        return (value as () => unknown).bind(db);
      }
      return value;
    },
    set(_target, prop, value) {
      (resolved() as unknown as Mutable)[prop] = value;
      return true;
    },
    has(_target, prop) {
      return typeof prop === 'string' && !INERT.has(prop) && prop in (resolved() as unknown as Mutable);
    },
  });
}

export function requiredDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (ISO-8601-UTC Postgres session conventions apply)');
  }
  return url;
}
