import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { channelAdapter } from './channel-registry';
import { MissingChannelEncryptionKeyError, openCredential } from './channel-credentials';
import type { ChannelCredential } from './channel-credentials';
import type { ChannelAvailabilityRequest } from './channel-availability-port';
import { ChannelsPublishService, type SyncDeliveryOutcome } from './channels.publish';
import {
  CHANNEL_AVAILABILITY_PUBLISHED_EVENT,
  type ChannelAvailabilityPublication,
  type PublishedScope,
} from './channels.events';

/**
 * The availability publication's delivery handler (story 7-1). The outbox
 * relay drains `channel.availability.published` rows and publishes them
 * through the (now routed) event bus; THIS class is the subscriber that
 * turns a publication into the port-arm attempt + the metering/health
 * stamps:
 *
 *   on an attempt — open the sealed credential in process (never logged,
 *   never persisted), invoke the adapter's availability arm, then settle
 *   through `ChannelsFacade.recordDelivery`: the metered
 *   `integration_calls` row, `last_attempt_at`, and on success
 *   `last_synced_at` + breaker reset, on failure the breaker's
 *   consecutive-failure rung.
 *
 *   then — on failure — RETHROW, after the stamps commit. The relay marks
 *   the row failed and re-drains with backoff (re-meters honestly), and
 *   dead-letters past its budget; the breaker opens at the frozen threshold
 *   and refuses further appends until a manual retry half-opens it.
 *
 * A publication whose connection row left mid-retry (a disconnect raced the
 * relay) ACKS: there is nothing to stamp and no delivery to retry. A
 * malformed payload ACKs (it is a publisher bug, not a transient outage —
 * and the relay's retry cannot fix a shape).
 */
@Injectable()
export class ChannelAvailabilityDelivery implements OnModuleInit {
  private readonly logger = new Logger('ChannelsDelivery');

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(ChannelsPublishService) private readonly channels: ChannelsPublishService,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(CHANNEL_AVAILABILITY_PUBLISHED_EVENT, (event) =>
      this.deliver(event),
    );
  }

  /** One delivery attempt (a relay publish is one invocation, at-least-once). */
  async deliver(event: DomainEvent): Promise<void> {
    if (event.type !== CHANNEL_AVAILABILITY_PUBLISHED_EVENT) {
      return;
    }
    const publication = decodePublication(event.payload);
    if (publication === null) {
      this.logger.error(
        `unroutable availability publication ${event.eventId} (malformed payload) — acking, not retrying`,
      );
      return;
    }

    const row = await this.channels.integrationForDelivery(event.tenantId, publication.connectionId);
    if (row === null) {
      this.logger.log(
        `publication ${event.eventId} for connection ${publication.connectionId} dropped — the connection left before delivery`,
      );
      return;
    }

    const adapter = channelAdapter(row.provider);
    const startedAt = Date.now();
    let outcome: SyncDeliveryOutcome;
    let transportError: unknown = null;
    if (adapter === undefined) {
      outcome = { ok: false, error: 'adapter no longer registered', latencyMs: null };
    } else {
      let credential: ChannelCredential;
      try {
        credential = openCredential(row.credentialSealed);
      } catch (err) {
        // The key is gone or the blob is corrupt: fail the attempt (the
        // relay retries; the stamps record an honest lastError). Never the
        // credential's content in any message.
        outcome = {
          ok: false,
          error: err instanceof MissingChannelEncryptionKeyError
            ? 'credential unopenable (encryption key unavailable)'
            : 'credential could not be opened',
          latencyMs: null,
        };
        await this.channels.recordDelivery(event.tenantId, publication.connectionId, outcome);
        throw err;
      }
      const request: ChannelAvailabilityRequest = {
        tenantId: event.tenantId,
        integrationId: publication.connectionId,
        provider: row.provider,
        scopes: publication.scopes,
        publishedAt: publication.publishedAt,
      };
      try {
        await adapter.availabilityArm(credential, request);
        outcome = { ok: true, latencyMs: Date.now() - startedAt };
      } catch (err) {
        transportError = err;
        outcome = {
          ok: false,
          error: err instanceof Error
            ? err.message.slice(0, 300)
            : 'the availability arm failed',
          latencyMs: Date.now() - startedAt,
        };
      }
    }
    await this.channels.recordDelivery(event.tenantId, publication.connectionId, outcome);

    if (!outcome.ok) {
      // Settled already; the relay carries the retry from here.
      throw transportError ?? new Error('the availability delivery failed');
    }
  }
}

/** The publication payload's decode — shape-checked, ids-and-quantities only. */
function decodePublication(payload: Record<string, unknown>): ChannelAvailabilityPublication | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as {
    connectionId?: unknown;
    provider?: unknown;
    scopes?: unknown;
    publishedAt?: unknown;
  };
  if (
    typeof record.connectionId !== 'string' ||
    typeof record.provider !== 'string' ||
    typeof record.publishedAt !== 'string' ||
    !Array.isArray(record.scopes)
  ) {
    return null;
  }
  const scopes: PublishedScope[] = [];
  for (const scope of record.scopes) {
    if (typeof scope !== 'object' || scope === null) {
      return null;
    }
    const item = scope as { warehouseId?: unknown; skuId?: unknown; visibleMilli?: unknown };
    if (
      typeof item.warehouseId !== 'string' ||
      typeof item.skuId !== 'string' ||
      typeof item.visibleMilli !== 'number' ||
      !Number.isInteger(item.visibleMilli)
    ) {
      return null;
    }
    scopes.push({
      warehouseId: item.warehouseId,
      skuId: item.skuId,
      visibleMilli: item.visibleMilli,
    });
  }
  return {
    connectionId: record.connectionId,
    provider: record.provider,
    scopes,
    publishedAt: record.publishedAt,
  };
}