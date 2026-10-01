import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { channelAdapter } from './channel-registry';
import { MissingChannelEncryptionKeyError, openCredential } from './channel-credentials';
import type { ChannelCredential } from './channel-credentials';
import type { ChannelOrderWritebackRequest } from './channel-writeback-port';
import { OutboundFacade } from '../outbound/outbound.facade';
import type { OrderSnapshot } from '../outbound/outbound.facade';
import { ChannelsPublishService } from './channels.publish';

/**
 * The fulfillment writeback's delivery handler (story 7.2, row 7 / RD-7) —
 * the `channel-availability.delivery.ts` shape against the ORDER path's
 * events: the outbox relay drains `order.packed` / `order.dispatched` /
 * `order.cancelled` rows through the routed event bus; THIS subscriber
 * turns one into the adapter's writeback attempt.
 *
 * The relayed payload is never trusted for the order's channel arms — the
 * handler RE-READS the order row (RD-7) and filters hard:
 *
 *   unknown order / not `source: 'ingested'` / no channel identity →
 *   ACK, no meter row (a manual order's lifecycle is none of the
 *   channels' business); the connection gone → ACK, no meter (the 7-1
 *   gone-arm); the credential unopenable → meter + RETHROW (the relay
 *   retries); otherwise the arm — whose read-back is state-specific and
 *   idempotent — then a settle through `recordWritebackDelivery`: a meter
 *   row kind `order-writeback` and NOTHING ELSE.
 *
 *   Writeback settle NEVER touches `last_synced_at`, `last_error`,
 *   `consecutive_failures` or the availability breaker (RD-7's
 *   decoupling — `recordDelivery`'s arm hardcodes the sync stamps; a
 *   shared breaker would stop availability publishing exactly at
 *   flash-sale peak, when stale channel quantity is most dangerous).
 *   The retry/backoff budget is the relay's alone; a failing writeback
 *   rethrows AFTER the meter commits, and dead-letters past budget.
 *
 * The at-least-once relay + the arm's per-state read-back (packed posts
 * only with no fulfillment; dispatched updates a tracking-less one, acks a
 * tracked one; cancelled acks an already-cancelled channel order) make a
 * redrained row self-heal — the channel-initiated-cancel echo settles as
 * one idempotent no-op call (RN-5: best-effort dedupe, not a proof — the
 * sub-second crash window survives by design, honestly).
 */
@Injectable()
export class ChannelWritebackDelivery implements OnModuleInit {
  private readonly logger = new Logger('ChannelsDelivery');

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(ChannelsPublishService) private readonly publish: ChannelsPublishService,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  onModuleInit(): void {
    for (const type of ORDER_WRITEBACK_EVENTS) {
      this.eventBus.subscribe(type, (event) => this.deliver(event, type));
    }
  }

  /** One delivery attempt (a relay publish is one invocation, at-least-once). */
  async deliver(event: DomainEvent, type: string): Promise<void> {
    if (!ORDER_WRITEBACK_EVENTS.includes(type)) {
      return;
    }
    const target = decodeWritebackTarget(type, event.payload);
    if (target === null) {
      // A malformed payload is a publisher bug, not a transient outage —
      // the relay's retry cannot fix a shape.
      this.logger.error(
        `unroutable writeback event ${event.eventId} (malformed payload) — acking, not retrying`,
      );
      return;
    }

    // The order re-read (RD-7 — the payload never carries the channel arms).
    const order = await this.orderForWriteback(event.tenantId, target.orderId);
    if (order === null) {
      // No order row (an admin delete raced the relay) — nothing to say to
      // the channel; ack.
      return;
    }
    if (order.source !== 'ingested' || order.integrationId === null || order.externalEventId === null) {
      // The source filter: a manual order's lifecycle is never a channel's
      // business — ack, no meter, no effect.
      return;
    }
    const connectionId = order.integrationId;
    const row = await this.publish.integrationForDelivery(event.tenantId, connectionId);
    if (row === null) {
      // The gone-connection arm (the 7-1 handler's posture): nothing to
      // meter, no delivery to retry — ack.
      this.logger.log(
        `writeback ${event.eventId} for connection ${connectionId} dropped — the connection left before delivery`,
      );
      return;
    }
    const adapter = channelAdapter(row.provider);
    if (adapter === undefined) {
      await this.settleFailure(event.tenantId, connectionId, 'adapter no longer registered');
      throw new Error('the writeback delivery failed: adapter no longer registered');
    }

    const credential = this.openCredential(event.tenantId, connectionId, row.credentialSealed);
    if (typeof credential === 'string') {
      await this.settleFailure(event.tenantId, connectionId, credential);
      throw new Error('the writeback delivery failed: credential unopenable');
    }

    // The channel-facing lines: the mapping set resolves skuId → externalRef
    // (a fresh read — the mappings PUT may have changed since ingest). A
    // line with no live mapping is left out; when NO line resolves on an
    // item-carrying state the attempt fails (a fulfillment of zero items
    // would lie to the channel) and the relay retries — the mapping PUT
    // heals the redrain. The `cancelled` state carries no items, so an
    // unmapped cancel still settles.
    const mappings = new Map(
      (await this.publish.listChannelMappings(event.tenantId, connectionId)).map((m) => [m.skuId, m.externalRef]),
    );
    const lines = order.lines
      .map((line) => {
        const externalRef = mappings.get(line.skuId);
        return externalRef === undefined ? null : { externalRef, quantity: line.qty };
      })
      .filter((line): line is { externalRef: string; quantity: number } => line !== null);
    if (type !== 'order.cancelled' && lines.length === 0) {
      const error = 'no order line resolves to a channel SKU mapping — map the SKUs (relay retries)';
      await this.settleFailure(event.tenantId, connectionId, error);
      throw new Error(`the writeback delivery failed: ${error}`);
    }

    const request: ChannelOrderWritebackRequest = {
      tenantId: event.tenantId,
      integrationId: connectionId,
      provider: row.provider,
      orderRef: order.externalEventId,
      state: target.state,
      lines,
      ...(target.tracking === undefined ? {} : { tracking: target.tracking }),
      ...(target.carrier === undefined ? {} : { carrier: target.carrier }),
    };

    const startedAt = Date.now();
    try {
      await adapter.orderWritebackArm(credential, request);
    } catch (err) {
      await this.settleFailure(
        event.tenantId,
        connectionId,
        err instanceof Error ? err.message.slice(0, 300) : 'the writeback arm failed',
      );
      throw err;
    }
    await this.publish.recordWritebackDelivery(event.tenantId, connectionId, {
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      error: null,
    });
  }

  /** Open the sealed credential; a string return is the failure reason. */
  private openCredential(
    tenantId: string,
    connectionId: string,
    credentialSealed: string,
  ): ChannelCredential | string {
    try {
      return openCredential(credentialSealed);
    } catch (err) {
      // Never the credential's content in any message.
      return err instanceof MissingChannelEncryptionKeyError
        ? 'credential unopenable (encryption key unavailable)'
        : 'credential could not be opened';
    }
  }

  /** The failure settle (meter only — never a sync stamp, never a breaker). */
  private async settleFailure(
    tenantId: string,
    connectionId: string,
    error: string,
  ): Promise<void> {
    await this.publish
      .recordWritebackDelivery(tenantId, connectionId, {
        status: 'failed',
        latencyMs: null,
        error,
      })
      .catch(() => undefined);
  }

  private async orderForWriteback(
    tenantId: string,
    orderId: string,
  ): Promise<OrderSnapshot['order'] | null> {
    return this.outbound.orderForWriteback(tenantId, orderId);
  }
}

/** The event types this delivery rides. */
const ORDER_WRITEBACK_EVENTS: readonly string[] = [
  'order.packed',
  'order.dispatched',
  'order.cancelled',
];

/**
 * The decoded, shape-checked target per event type. The payload shape is
 * the command's own idempotency snapshot slice (`{pack}` / `{dispatch}` /
 * `{order}` — verified at the append sites), and ONLY the ids+ids are read:
 * the order's channel arms come from the RE-READ, never from here (RD-7).
 */
function decodeWritebackTarget(
  type: string,
  payload: Record<string, unknown>,
): { state: 'packed' | 'dispatched' | 'cancelled'; orderId: string; carrier?: string | null; tracking?: string | null } | null {
  const asString = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  if (type === 'order.packed') {
    const pack = (payload as { pack?: unknown }).pack;
    if (typeof pack !== 'object' || pack === null) return null;
    const orderId = asString((pack as { orderId?: unknown }).orderId);
    return orderId === null ? null : { state: 'packed', orderId };
  }
  if (type === 'order.dispatched') {
    const dispatch = (payload as { dispatch?: unknown }).dispatch;
    if (typeof dispatch !== 'object' || dispatch === null) return null;
    const record = dispatch as { orderId?: unknown; carrierName?: unknown; trackingNumber?: unknown };
    const orderId = asString(record.orderId);
    if (orderId === null) return null;
    const recordCarrier = record.carrierName;
    const recordTracking = record.trackingNumber;
    return {
      state: 'dispatched',
      orderId,
      carrier: typeof recordCarrier === 'string' ? recordCarrier : null,
      tracking: typeof recordTracking === 'string' ? recordTracking : null,
    };
  }
  if (type === 'order.cancelled') {
    const order = (payload as { order?: unknown }).order;
    if (typeof order !== 'object' || order === null) return null;
    const orderId = asString((order as { id?: unknown }).id);
    return orderId === null ? null : { state: 'cancelled', orderId };
  }
  return null;
}