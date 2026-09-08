/**
 * Outbox relay seam (architecture spine): domain events are committed to an
 * outbox table in the same transaction as the write, then relayed
 * at-least-once to the bus. The table and relay worker land with the first
 * cross-module write (Story 1.2+); this file fixes only the contract.
 */

export interface OutboxMessage {
  readonly messageId: string; // UUIDv7
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly publishedAt?: string;
}

export interface OutboxRelay {
  /** Poll-drain loop owned by the jobs shell, once the outbox table exists. */
  drain(limit: number): Promise<readonly OutboxMessage[]>;
}
