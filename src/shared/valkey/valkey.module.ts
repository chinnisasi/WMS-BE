import { Module } from '@nestjs/common';
import { ValkeyClient } from './valkey.client';

/**
 * The Valkey module (story 2.3): provides the shared atomic-decision client —
 * ioredis against `VALKEY_URL`, scripts pre-declared, no other Valkey surface.
 * Valkey carries ONLY reservation decision state; the Postgres `reservations`
 * journal is the truth it mirrors (and is always rebuilt from).
 */
@Module({
  providers: [ValkeyClient],
  exports: [ValkeyClient],
})
export class ValkeyModule {}