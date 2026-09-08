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

/** DI token for the event bus seam — provided by SharedModule for every module. */
export const EVENT_BUS = 'EVENT_BUS' as const;