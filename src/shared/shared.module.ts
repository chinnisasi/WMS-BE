import type { ModuleMetadata, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createLazyAuthDatabase, createLazyDatabase } from './db/db';
import { EVENT_BUS, LoggingEventBus } from './events/event-bus';
import { OUTBOX_RELAY, OUTBOX_SINK } from './events/outbox.seam';
import { PostgresOutboxRelay, PostgresOutboxSink } from './events/outbox';
import { ProblemDetailsFilter } from './problem-details/problem-details.filter';
import { AUTH_DATABASE, DATABASE } from './db/tokens';

export type { ModuleMetadata };

// The client tokens keep their long-standing public surface: every module
// imports them from this module (they are declared in `db/tokens.ts`, a leaf,
// so infrastructure provided here can inject them without an import cycle).
export { DATABASE, AUTH_DATABASE } from './db/tokens';

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
    // The event bus seam is shared infrastructure: every emitting module
    // (tenancy since 1.2, catalog since 1.4) injects the same token.
    { provide: EVENT_BUS, useClass: LoggingEventBus },
    // The transactional outbox (AD-7, story outbox-relay): commands append
    // in-transaction through OUTBOX_SINK; the jobs-shell relay worker drives
    // OUTBOX_RELAY, which publishes through EVENT_BUS above.
    { provide: OUTBOX_SINK, useClass: PostgresOutboxSink },
    { provide: OUTBOX_RELAY, useClass: PostgresOutboxRelay },
  ],
  exports: [DATABASE, AUTH_DATABASE, EVENT_BUS, OUTBOX_SINK, OUTBOX_RELAY],
})
export class SharedModule {}