import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { webhookDeliveries, webhookEndpoints, webhookEvents } from '../../shared/db/schema';
import { isTransientDbError } from '../../shared/db/transient-error';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { departedClientIdsInTx, getClientsInTx } from '../clients/clients.facade';
import { getWarehouseCodeInTx } from '../tenancy/tenancy.service';
import { OutboundFacade } from '../outbound/outbound.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InboundFacade } from '../inbound/inbound.facade';
import {
  WEBHOOK_MAX_HELD_PER_ENDPOINT,
  WEBHOOK_SOURCE_EVENTS,
  WEBHOOK_SOURCE_EVENT_TYPES,
  type WebhookEventType,
  type WebhookSourceEvent,
} from './webhook-rules';
import {
  buildWebhookBody,
  decodeDelivery,
  decodeDispatch,
  decodeReceipt,
  deliveryData,
  deliverySubjectUuid,
  dispatchData,
  receiptData,
  type WebhookEnvelopeHead,
} from './webhook-payloads';

/** One source event as the enqueue reads it (a relayed `DomainEvent`, or a quarantined outbox row). */
export interface WebhookSource {
  readonly type: string;
  /** The outbox row id (logs only — events are keyed by SUBJECT, A1). */
  readonly eventId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

/** What one enqueue did (the suites and the reconcile arm read it). */
export type EnqueueOutcome =
  | { readonly kind: 'enqueued'; readonly eventId: string; readonly deliveries: number; readonly held: number }
  /** The subject already has its event (a redelivery, the reconcile, an operator replay). */
  | { readonly kind: 'duplicate' }
  /** Nothing to send: no subscribed endpoint, a self or departed client, or no client at all. */
  | { readonly kind: 'skipped'; readonly reason: 'no-endpoint' | 'no-client' | 'self-client' | 'client-departed' | 'not-a-source' }
  /** The payload cannot be built from — logged and acked; no retry fixes a shape. */
  | { readonly kind: 'malformed' };

/**
 * Story 5-2a — the webhook QUEUE writer. Turns `grn.recorded` and
 * `order.dispatched` into ONE frozen, versioned, minimised webhook event per
 * subject (the GRN id or the order id — `webhook_events_subject_unique`),
 * with one delivery per endpoint of the client that is subscribed to the
 * type and `active` (→ `pending`) or auto-disabled for `failing` (→ `held`,
 * A5) at enqueue time. It makes NO network call (pinned by
 * `test/architecture.spec.ts`): the relay is one serial loop for every
 * tenant, so the `WebhookSender` sends.
 *
 * The client: a receipt's `goodsReceipt.clientId` (none → no webhook, logged
 * and acked — an older build's mixed-client blind receipt); a dispatch's
 * order through `OutboundFacade.orderClientIdsInTx` (the payload carries
 * none). The `self` client and a departed one get none.
 *
 * `enqueueFromSourceInTx` is shared with the sender's quarantine reconcile
 * arm (A1) — the subject unique makes both idempotent.
 */
@Injectable()
export class WebhookEnqueue {
  private readonly logger = new Logger('WebhookEnqueue');

  constructor(
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
  ) {}

  async enqueueFromSourceInTx(tx: TenantTx, tenantId: string, source: WebhookSource): Promise<EnqueueOutcome> {
    if (!(WEBHOOK_SOURCE_EVENT_TYPES as readonly string[]).includes(source.type)) return { kind: 'skipped', reason: 'not-a-source' };
    const type: WebhookEventType = WEBHOOK_SOURCE_EVENTS[source.type as WebhookSourceEvent];

    let subjectId: string;
    let clientId: string | null;
    let build: (clientCode: string, head: Omit<WebhookEnvelopeHead, 'clientCode'>) => Promise<string | null>;
    if (type === 'receipt.recorded') {
      const fact = decodeReceipt(source.payload);
      if (fact === null) return this.malformed(source);
      subjectId = fact.grnId;
      clientId = fact.clientId;
      build = async (clientCode, head) => {
        const [warehouseCode, poCodes, skus, qcHeld] = [
          await getWarehouseCodeInTx(tx, tenantId, fact.warehouseId),
          fact.poId === null ? new Map<string, string>() : await this.inbound.poCodesByIdsInTx(tx, tenantId, [fact.poId]),
          await this.catalog.skuLabelsInTx(tx, tenantId, fact.lines.map((line) => line.skuId)),
          await this.inbound.receiptQcHeldLineIdsInTx(tx, tenantId, fact.grnId),
        ];
        const built = receiptData(fact, {
          warehouseCode,
          purchaseOrderCode: fact.poId === null ? null : (poCodes.get(fact.poId) ?? null),
          skus,
          qcHeldLineIds: qcHeld,
        });
        return buildWebhookBody({ ...head, clientCode }, built);
      };
    } else if (type === 'order.delivered') {
      // Story 4-9a (A28) — the payload names its client (the receipt arm's
      // shape, never through the order); one event per recorded version.
      const fact = decodeDelivery(source.payload);
      if (fact === null) return this.malformed(source);
      subjectId = deliverySubjectUuid(fact.consignmentId, fact.deliverySeq);
      clientId = fact.clientId;
      build = async (clientCode, head) => {
        const warehouseCode = await getWarehouseCodeInTx(tx, tenantId, fact.warehouseId);
        const ref = (await this.outbound.orderRefsInTx(tx, tenantId, [fact.orderId])).get(fact.orderId);
        const built = deliveryData(
          fact,
          { warehouseCode, clientOrderRef: ref?.clientOrderRef ?? null, channelOrderRef: ref?.externalEventId ?? null },
          head.occurredAt,
        );
        return buildWebhookBody({ ...head, clientCode }, built);
      };
    } else {
      const fact = decodeDispatch(source.payload);
      if (fact === null) return this.malformed(source);
      subjectId = fact.orderId;
      clientId = (await this.outbound.orderClientIdsInTx(tx, tenantId, [fact.orderId])).get(fact.orderId) ?? null;
      build = async (clientCode, head) => {
        const [warehouseCode, skus, kitParents] = [
          await getWarehouseCodeInTx(tx, tenantId, fact.warehouseId),
          await this.catalog.skuLabelsInTx(tx, tenantId, fact.lines.map((line) => line.skuId)),
          await this.outbound.kitParentLineIdsInTx(tx, tenantId, fact.lines.map((line) => line.orderLineId)),
        ];
        return buildWebhookBody({ ...head, clientCode }, dispatchData(fact, { warehouseCode, skus, kitParentLineIds: kitParents }));
      };
    }

    if (clientId === null) {
      this.logger.warn(`${source.type} ${source.eventId} (tenant ${tenantId}): no client on the subject — no webhook`);
      return { kind: 'skipped', reason: 'no-client' };
    }

    // The endpoints first: no subscriber, no event (the common case is cheap).
    const endpoints = await tx
      .select({ id: webhookEndpoints.id, status: webhookEndpoints.status, disabledReason: webhookEndpoints.disabledReason, schemaVersion: webhookEndpoints.schemaVersion })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.tenantId, tenantId),
          eq(webhookEndpoints.clientId, clientId),
          sql`(${webhookEndpoints.status} = 'active' or (${webhookEndpoints.status} = 'disabled' and ${webhookEndpoints.disabledReason} = 'failing'))`,
          sql`${webhookEndpoints.eventTypes} @> array[${type}]::text[]`,
        ),
      );
    if (endpoints.length === 0) return { kind: 'skipped', reason: 'no-endpoint' };

    const client = (await getClientsInTx(tx, tenantId, [clientId])).get(clientId);
    if (client === undefined) return { kind: 'skipped', reason: 'no-client' };
    if (client.systemOwned) return { kind: 'skipped', reason: 'self-client' };
    if ((await departedClientIdsInTx(tx, tenantId)).has(clientId)) return { kind: 'skipped', reason: 'client-departed' };

    // Already enqueued? (Cheaper than building the body for a redelivery.)
    const existing = await tx
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.tenantId, tenantId), eq(webhookEvents.eventType, type), eq(webhookEvents.subjectId, subjectId)))
      .limit(1);
    if (existing.length > 0) return { kind: 'duplicate' };

    const eventId = uuidv7();
    const createdAt = nowIso();
    // v1 only today (A21): every endpoint's version is 1, so one body serves all.
    let body: string | null;
    try {
      body = await build(client.code, {
        id: eventId,
        type,
        schemaVersion: 1,
        occurredAt: new Date(source.occurredAt).toISOString(),
        createdAt: new Date(createdAt).toISOString(),
      });
    } catch (err) {
      if (isTransientDbError(err)) throw err;
      this.logger.error(`${source.type} ${source.eventId} (tenant ${tenantId}): the webhook body could not be built — no webhook: ${(err as Error).message}`);
      return { kind: 'malformed' };
    }
    if (body === null) {
      this.logger.error(`${source.type} ${source.eventId} (tenant ${tenantId}): the webhook body exceeds the limit even without lines — no webhook`);
      return { kind: 'malformed' };
    }

    const inserted = await tx
      .insert(webhookEvents)
      .values({ id: eventId, tenantId, clientId, eventType: type, subjectId, body, createdAt, updatedAt: createdAt })
      .onConflictDoNothing({ target: [webhookEvents.tenantId, webhookEvents.eventType, webhookEvents.subjectId] })
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) return { kind: 'duplicate' };

    const rows = endpoints.map((endpoint) => ({
      tenantId,
      clientId,
      eventId,
      endpointId: endpoint.id,
      status: endpoint.status === 'active' ? 'pending' : 'held',
      attempts: 0,
      nextAttemptAt: createdAt,
      pendingSince: createdAt,
    }));
    await tx
      .insert(webhookDeliveries)
      .values(rows)
      .onConflictDoNothing({ target: [webhookDeliveries.tenantId, webhookDeliveries.eventId, webhookDeliveries.endpointId] });
    const heldEndpoints = endpoints.filter((endpoint) => endpoint.status !== 'active').map((endpoint) => endpoint.id);
    if (heldEndpoints.length > 0) await trimHeldInTx(tx, tenantId, heldEndpoints);
    return { kind: 'enqueued', eventId, deliveries: rows.length, held: heldEndpoints.length };
  }

  private malformed(source: WebhookSource): EnqueueOutcome {
    this.logger.error(`${source.type} ${source.eventId}: malformed payload — no webhook, acking`);
    return { kind: 'malformed' };
  }
}

/**
 * A5 — at most `WEBHOOK_MAX_HELD_PER_ENDPOINT` held rows per endpoint: past
 * it the OLDEST fail `held-overflow`. Returns how many it failed.
 */
export async function trimHeldInTx(tx: TenantTx, tenantId: string, endpointIds: readonly string[]): Promise<number> {
  if (endpointIds.length === 0) return 0;
  const rows = (await tx.execute(sql`
    update webhook_deliveries d
       set status = 'failed', last_error_code = 'held-overflow', updated_at = now()
     where d.id in (
       select ranked.id from (
         select h.id, row_number() over (partition by h.endpoint_id order by h.created_at desc, h.id desc) as rn
           from webhook_deliveries h
          where h.tenant_id = ${tenantId}::uuid and h.status = 'held'
            and h.endpoint_id = any(${sql.param([...endpointIds])}::uuid[])
       ) ranked
       where ranked.rn > ${WEBHOOK_MAX_HELD_PER_ENDPOINT}
     )
    returning d.id
  `)) as unknown as { id: string }[];
  return rows.length;
}

/**
 * The outbox subscriber (decision 7, A11, A25). It subscribes in
 * `onApplicationBootstrap` — every other handler subscribes in
 * `onModuleInit`, and the bus runs handlers in subscription order, so this
 * one is always LAST on both types: a throw here cannot stop invoicing or
 * channel writeback on that attempt. The ONLY handler allowed to subscribe
 * there (IMPLEMENTATION-GUIDE; `test/architecture.spec.ts`).
 *
 * It rethrows only a connection or serialization fault (`isTransientDbError`
 * — a rethrow re-drains the whole row, re-running invoicing (idempotent) and
 * channel writeback (an extra Shopify round trip)); everything else, data
 * faults included, is logged and acked.
 */
@Injectable()
export class WebhookEnqueueHandler implements OnApplicationBootstrap {
  private readonly logger = new Logger('WebhookEnqueueHandler');

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WebhookEnqueue) private readonly enqueue: WebhookEnqueue,
  ) {}

  onApplicationBootstrap(): void {
    for (const type of WEBHOOK_SOURCE_EVENT_TYPES) {
      this.eventBus.subscribe(type, async (event) => {
        await this.deliver(event);
      });
    }
  }

  /** One delivery attempt (at-least-once — the subject unique makes it idempotent). */
  async deliver(event: DomainEvent): Promise<EnqueueOutcome | null> {
    try {
      return await withTenantTransaction(this.db, event.tenantId, (tx) =>
        this.enqueue.enqueueFromSourceInTx(tx, event.tenantId, {
          type: event.type,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          payload: event.payload,
        }),
      );
    } catch (err) {
      if (isTransientDbError(err)) {
        this.logger.error(`${event.type} ${event.eventId}: webhook enqueue hit a transient database fault — retrying via relay`);
        throw err;
      }
      this.logger.error(`${event.type} ${event.eventId}: webhook enqueue failed — acking (no retry can fix it): ${(err as Error).message}`);
      return null;
    }
  }
}
