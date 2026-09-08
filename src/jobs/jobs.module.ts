import { Module } from '@nestjs/common';

/**
 * jobs shell — background/relay workers (outbox relay, import batches,
 * notifications dispatch). The event bus + outbox relay seams live in
 * shared/events; the first real worker (outbox relay) lands with the first
 * cross-module write in Story 1.2+.
 */
@Module({
  providers: [],
  exports: [],
})
export class JobsModule {}
