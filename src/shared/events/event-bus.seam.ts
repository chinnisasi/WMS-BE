/**
 * Event bus seam (architecture spine): modules communicate only through
 * interfaces and domain events. The real bus (and its delivery guarantees)
 * lands with the first cross-module flows; only the contract exists here.
 */

export interface DomainEvent<T extends string = string> {
  readonly eventId: string; // UUIDv7
  readonly type: T;
  readonly tenantId: string;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly payload: Record<string, unknown>;
}

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(type: string, handler: (event: DomainEvent) => Promise<void>): void;
}
