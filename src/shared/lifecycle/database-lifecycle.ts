import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { closeLazyDatabase, type Database } from '../db/db';
import { AUTH_DATABASE, DATABASE } from '../db/tokens';
import { resetShutdownDrainDeadline } from './shutdown';

/** Seconds an in-flight query gets to finish once its pool starts closing. */
export const POOL_CLOSE_TIMEOUT_SECONDS = 3;

/**
 * Story 6-2a (A1) — closes both Postgres pools in `onApplicationShutdown`,
 * the LAST phase: after the workers' ticks and the HTTP requests have
 * drained (`beforeApplicationShutdown`) and the server has closed
 * (`dispose`). It goes through `closeLazyDatabase`, never through the lazy
 * proxy, so a pool the process never opened is not opened to be closed.
 * Valkey closes itself in the same phase (`ValkeyClient.onApplicationShutdown`,
 * `quit`).
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('DatabaseLifecycle');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // The drain phase is over: a later shutdown in this process (a test
    // closing a second app) starts its own deadline.
    resetShutdownDrainDeadline();
    const results = await Promise.allSettled([
      closeLazyDatabase(this.db, POOL_CLOSE_TIMEOUT_SECONDS),
      closeLazyDatabase(this.authDb, POOL_CLOSE_TIMEOUT_SECONDS),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Closing a Postgres pool failed: ${String(result.reason)}`);
      }
    }
  }
}
