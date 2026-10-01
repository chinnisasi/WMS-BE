import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, EventBus } from './event-bus.seam';

/**
 * First real EventBus implementation of the seam (Story 1.2): the command
 * layer emits domain events after a committed write. The delivery-guaranteed
 * bus (outbox + relay) lands with the first cross-module consumer; until then
 * events are logged — the seam contract stays identical, so swapping the
 * implementation later cannot touch the command services.
 */
@Injectable()
export class LoggingEventBus implements EventBus {
  private readonly logger = new Logger('EventBus');

  async publish(event: DomainEvent): Promise<void> {
    // No payload: event bodies can carry PII (owner emails) — type, tenant
    // and event id are enough to correlate with the outbox later.
    this.logger.log(`${event.type} tenant=${event.tenantId} event=${event.eventId}`);
  }

  subscribe(): void {
    // No cross-module handlers exist yet (Story 1.2 emits only). The outbox
    // relay replaces direct subscription when delivery guarantees arrive.
  }
}

/**
 * The type-routed in-process bus (story 7-1): the real delivery seam the
 * outbox relay publishes through. Subscribers register per event type; a
 * publish forwards the event to each handler IN ORDER and awaits it, so a
 * throwing handler propagates to the relay's publish — the row re-drains
 * with backoff and dead-letters past the retry budget (AD-7's at-least-once
 * contract, with the ACK meaning "every handler settled").
 *
 * This deliberately REPLACES `LoggingEventBus` as the SharedModule provider,
 * keeping that class's logging (every publish logs the same correlated
 * line). The seam contract (`event-bus.seam.ts`) does not change, so
 * existing publishers are untouched. Handlers must be idempotent: the relay
 * re-delivers on crash between publish and ack — exactly-once EFFECT is the
 * consumer's (AD-5).
 */
@Injectable()
export class RoutedEventBus implements EventBus {
  private readonly logger = new Logger('EventBus');

  private readonly handlers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();

  async publish(event: DomainEvent): Promise<void> {
    // No payload in the log line: event bodies can carry PII (owner
    // emails) — type, tenant and event id are enough to correlate with the
    // outbox row.
    this.logger.log(`${event.type} tenant=${event.tenantId} event=${event.eventId}`);
    const handlers = this.handlers.get(event.type);
    for (const handler of handlers ?? []) {
      await handler(event);
    }
  }

  subscribe(type: string, handler: (event: DomainEvent) => Promise<void>): void {
    const existing = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...existing, handler]);
  }
}

/** DI token for the event bus seam — provided by SharedModule for every module. */
export const EVENT_BUS = 'EVENT_BUS' as const;