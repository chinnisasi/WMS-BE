/**
 * DI tokens for the shared database clients (see `shared/db/db.ts`).
 *
 * They live in their own leaf module (re-exported by `shared.module.ts`) so
 * infrastructure that is itself provided by SharedModule — the outbox sink and
 * relay (story outbox-relay) — can `@Inject` them without an import cycle.
 */
export const DATABASE = 'DATABASE' as const;

/**
 * DI token for the auth-time Drizzle client: the only connection allowed to
 * read before a tenant scope exists (BYPASSRLS role — see `shared/db/db.ts`).
 */
export const AUTH_DATABASE = 'AUTH_DATABASE' as const;