import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../primitives/ids';

/**
 * Infrastructure-only table proving the Drizzle migration pipeline (Story 1.1).
 * No domain tables exist yet — tenant/zone/bin/SKU schemas start in 1.2–1.4.
 */
export const appMetadata = pgTable('app_metadata', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  key: text('key').notNull().unique(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type AppMetadata = typeof appMetadata.$inferSelect;