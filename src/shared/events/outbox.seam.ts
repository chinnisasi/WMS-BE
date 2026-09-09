/**
 * Outbox relay seam (architecture spine): domain events are committed to an
 * outbox table in the same transaction as the write, then relayed
 * at-least-once to the bus. The real implementation lives in
 * `shared/events/outbox.ts` (registered in SharedModule beside `EVENT_BUS`).
 */
import type { TenantTx } from '../db/tenant-scope';

/**
 * DI tokens for the outbox seam (the implementations and their providers live
 * in `outbox.ts`; the tokens sit here so SharedModule can reference them
 * without an import cycle).
 */
export const OUTBOX_SINK = 'OUTBOX_SINK' as const;

/** DI token for the relay (the read/deliver side) — the jobs worker drives it. */
export const OUTBOX_RELAY = 'OUTBOX_RELAY' as const;

export interface OutboxMessage {
  readonly messageId: string; // UUIDv7
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly publishedAt?: string;
}

/** The write side (AD-7): append inside the domain write's own transaction. */
export interface OutboxSink {
  /**
   * Inserts one pending outbox row in the caller's transaction — the row
   * commits (or rolls back) together with the write that produced the event.
   * `message.messageId` becomes the relayed `DomainEvent.eventId` unchanged,
   * so a logged publish always correlates back to its outbox row.
   */
  append(tx: TenantTx, message: OutboxMessage): Promise<void>;
}

export interface OutboxRelay {
  /**
   * Poll-drain loop owned by the jobs shell. One call = one cycle: session
   * advisory-locked (concurrent cycles shed), drains due pending rows
   * per-tenant oldest-first (`created_at, id`), publishes each through
   * `EVENT_BUS`, deletes on ack; on failure the row re-drains after backoff
   * and quarantines past the retry budget. Returns the messages published in
   * this cycle (at-least-once: a crash between publish and ack re-publishes).
   */
  drain(limit: number): Promise<readonly OutboxMessage[]>;
}
