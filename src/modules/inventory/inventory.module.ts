import { Module } from '@nestjs/common';

/**
 * Inventory module — spine module placeholder (Story 1.1).
 *
 * Ownership discipline (architecture spine): this module exclusively owns
 * its tables and publishes domain events. Other modules communicate with it
 * only through its public interfaces and events — never its tables.
 * Implementation starts in later stories (1.2+ for tenancy/catalog).
 */
@Module({
  providers: [],
  exports: [],
})
export class InventoryModule {}
