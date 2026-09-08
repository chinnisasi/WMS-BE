import type { ModuleMetadata, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createLazyAuthDatabase, createLazyDatabase } from './db/db';
import { ProblemDetailsFilter } from './problem-details/problem-details.filter';

export type { ModuleMetadata };

/** DI token for the shared Drizzle `Database` client (see `shared/db/db.ts`). */
export const DATABASE = 'DATABASE' as const;

/**
 * DI token for the auth-time Drizzle client: the only connection allowed to
 * read before a tenant scope exists (BYPASSRLS role — see `shared/db/db.ts`).
 */
export const AUTH_DATABASE = 'AUTH_DATABASE' as const;

/**
 * Shared primitives (AD-9): ids, time, money, quantity, GST basis points,
 * cursor pagination, problem-details, idempotency/event/outbox seams, and the
 * Drizzle `Database` client. Spine modules import this module as they gain
 * functionality; nothing outside shared/ re-implements these primitives.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    {
      provide: DATABASE,
      useFactory: createLazyDatabase,
    } satisfies Provider,
    {
      provide: AUTH_DATABASE,
      useFactory: createLazyAuthDatabase,
    } satisfies Provider,
  ],
  exports: [DATABASE, AUTH_DATABASE],
})
export class SharedModule {}