import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { isTransientDbError } from '../../shared/db/transient-error';
import { uuidv7TimestampMs } from '../../shared/primitives/ids';
import { istDateOf } from '../../shared/primitives/time';
import { decodeDispatch, decodeReceipt } from '../../shared/primitives/client-event-facts';
import {
  CLIENT_EMAIL_EVENT_TEMPLATE,
  getClientInTx,
  getClientsInTx,
  subscribedContactsInTx,
  type ClientEmailEvent,
} from '../clients/clients.facade';
import { getTenantNameInTx, getWarehouseNameInTx } from '../tenancy/tenancy.service';
import { OutboundFacade } from '../outbound/outbound.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InboundFacade } from '../inbound/inbound.facade';
import {
  clientEmailCountsTodayInTx,
  queueClientEmailInTx,
  type ClientDispatchEmailParams,
  type ClientDocumentsNeededEmailParams,
  type ClientReceiptEmailParams,
  type ClientShipmentDocumentEmailParams,
} from '../mail/mail.facade';
import {
  CLIENT_EMAIL_DAILY_CAP,
  CLIENT_EMAIL_SOURCE_EVENTS,
  CLIENT_EMAIL_SOURCE_EVENT_TYPES,
  CLIENT_EMAIL_STALE_EVENT_MS,
  clientEmailEnabled,
  type ClientEmailSourceEvent,
} from './client-email-rules';
import {
  buildDispatchEmailParams,
  buildDocumentsNeededEmailParams,
  buildReceiptEmailParams,
  buildShipmentDocumentEmailParams,
  clientEmailDedupeKey,
  decodeDocumentShared,
  decodePackedOrderId,
  qcHeldLinesOf,
} from './client-email-params';
// Story 4-6a (A12, A20) — the record's seam (guide §7h): never the invoicing module.
import { dispatchedConsignmentRecordsOfOrdersInTx } from '../invoicing/consignment-seam';

/** Why an event queued nothing (never a row — decision 4's skip table). */
export type ClientEmailSkipReason =
  | 'disabled'
  | 'not-a-source'
  | 'stale'
  | 'no-client'
  | 'self-client'
  | 'client-departed'
  | 'no-subscriber'
  | 'over-cap'
  // Story 4-4a — the shared file (or its order or handover) is gone, or not the event's client's.
  | 'document-gone'
  // Story 4-6a (A20, A36, A47) — the documents-needed reminder: the order is no
  // longer open at delivery, its gate is not blocking any more (a record
  // arrived), or the gate could not be read (a data fault — acked, never rethrown).
  | 'not-open'
  | 'not-blocking'
  | 'gate-unreadable';

/** What one delivery did (the suites read it). */
export type ClientEmailOutcome =
  | { readonly kind: 'queued'; readonly queued: number; readonly deduped: number }
  | { readonly kind: 'skipped'; readonly reason: ClientEmailSkipReason }
  /** The payload cannot be built from — logged and acked; no retry fixes a shape. */
  | { readonly kind: 'malformed' }
  /** The enqueue failed (after one in-process retry of a transient fault) — logged and acked (A6). */
  | { readonly kind: 'failed' };

/** The clock the staleness rule reads (a suite moves it). */
export const clientEmailClock = { now: (): number => Date.now() };

/**
 * Story 5-2b — the client-email QUEUE writer: an outbox subscriber that
 * turns `grn.recorded` and `order.dispatched` into ONE `email_messages` row
 * per opted-in contact of the event's client, through
 * `queueClientEmailInTx` (the mail module stays the only writer). It makes
 * NO network call — the mail sender sends (pinned by
 * `test/architecture.spec.ts`).
 *
 * Per event, one tenant transaction: resolve the client (a receipt's
 * `goodsReceipt.clientId`; a dispatch's order through
 * `OutboundFacade.orderClientIdsInTx`) → skip a missing, `self` or departed
 * client (a suspended one still ships, so it still hears) → the subscribed
 * contacts (`subscribedContactsInTx`) → the daily cap (A5: all of the
 * event's recipients while today's count is below 500, else none) → the
 * labels → the params, key by key → one insert per recipient, deduped on
 * `{template}:{subjectId}:{email}`.
 *
 * Errors (A6): a transient database fault (`isTransientDbError`) retries the
 * transaction ONCE in-process; after that, and on any other error, it logs
 * `client-email.enqueue-failed` and ACKS. It never rethrows — an email is a
 * courtesy notice, and a rethrow would re-drain a row invoicing and channel
 * writeback share, and push it toward quarantine.
 *
 * Subscribes in `onModuleInit`, like every handler but 5-2a's webhook
 * enqueue (IMPLEMENTATION-GUIDE §7j, A25). Logs carry the tenant, the client,
 * the template and ids only — never an address, a subject or a body.
 */
@Injectable()
export class ClientEmailsEnqueueHandler implements OnModuleInit {
  private readonly logger = new Logger('ClientEmailsEnqueue');
  /** (tenant, client, template, IST day) already warned over the cap — one warn per day. */
  private readonly capWarned = new Set<string>();
  private capWarnedDay = '';

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
  ) {}

  onModuleInit(): void {
    for (const type of CLIENT_EMAIL_SOURCE_EVENT_TYPES) {
      this.eventBus.subscribe(type, async (event) => {
        await this.deliver(event);
      });
    }
  }

  /** One delivery attempt. Never throws (A6). */
  async deliver(event: DomainEvent): Promise<ClientEmailOutcome> {
    if (!clientEmailEnabled()) return { kind: 'skipped', reason: 'disabled' };
    if (!(CLIENT_EMAIL_SOURCE_EVENT_TYPES as readonly string[]).includes(event.type)) return { kind: 'skipped', reason: 'not-a-source' };
    const appendedAt = uuidv7TimestampMs(event.eventId);
    if (appendedAt === null) {
      this.logger.error(`client-email.malformed type=${event.type} tenant=${event.tenantId} event=${event.eventId} — the event id is not a uuidv7, acking`);
      return { kind: 'malformed' };
    }
    if (clientEmailClock.now() - appendedAt > CLIENT_EMAIL_STALE_EVENT_MS) {
      this.logger.log(`client-email.skipped type=${event.type} tenant=${event.tenantId} event=${event.eventId} reason=stale`);
      return { kind: 'skipped', reason: 'stale' };
    }
    const attempt = () => withTenantTransaction(this.db, event.tenantId, (tx) => this.enqueueInTx(tx, event));
    try {
      try {
        return await attempt();
      } catch (err) {
        if (!isTransientDbError(err)) throw err;
        // A6 — one in-process retry of the whole transaction, then give up.
        return await attempt();
      }
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      this.logger.error(
        `client-email.enqueue-failed type=${event.type} tenant=${event.tenantId} event=${event.eventId} code=${typeof code === 'string' ? code : 'none'}`,
      );
      return { kind: 'failed' };
    }
  }

  async enqueueInTx(tx: TenantTx, event: DomainEvent): Promise<ClientEmailOutcome> {
    const tenantId = event.tenantId;
    const publicEvent: ClientEmailEvent = CLIENT_EMAIL_SOURCE_EVENTS[event.type as ClientEmailSourceEvent];
    const template = CLIENT_EMAIL_EVENT_TEMPLATE[publicEvent];
    const skip = (reason: ClientEmailSkipReason, clientId: string | null): ClientEmailOutcome => {
      this.logger.log(`client-email.skipped type=${event.type} tenant=${tenantId} client=${clientId ?? 'none'} event=${event.eventId} reason=${reason}`);
      return { kind: 'skipped', reason };
    };

    const receipt = publicEvent === 'receipt.recorded' ? decodeReceipt(event.payload) : null;
    const dispatch = publicEvent === 'order.dispatched' ? decodeDispatch(event.payload) : null;
    // Story 4-4a (D6) — a shared shipping document: the payload names its client.
    const document = publicEvent === 'shipment.documents' ? decodeDocumentShared(event.payload) : null;
    // Story 4-6a (A20) — a packed order: the reminder is judged at delivery.
    const packedOrderId = publicEvent === 'consignment.documents-needed' ? decodePackedOrderId(event.payload) : null;
    if (receipt === null && dispatch === null && document === null && packedOrderId === null) {
      this.logger.error(`client-email.malformed type=${event.type} tenant=${tenantId} event=${event.eventId} — no mail, acking`);
      return { kind: 'malformed' };
    }

    // 1. The client: on the receipt; through the order for a dispatch.
    const orderSubject = packedOrderId ?? dispatch?.orderId ?? null;
    const subjectId = receipt !== null ? receipt.grnId : document !== null ? document.attachmentId : orderSubject!;
    const clientId =
      receipt !== null
        ? receipt.clientId
        : document !== null
          ? document.clientId
          : ((await this.outbound.orderClientIdsInTx(tx, tenantId, [orderSubject!])).get(orderSubject!) ?? null);
    if (clientId === null) return skip('no-client', null);

    // 2. Missing, the tenant's own `self`, or departed: no mail. Existence is
    // checked first (D8 — `getClientInTx` 404s; no exception as control flow).
    const facts = (await getClientsInTx(tx, tenantId, [clientId])).get(clientId);
    if (facts === undefined) return skip('no-client', clientId);
    if (facts.systemOwned) return skip('self-client', clientId);
    const client = await getClientInTx(tx, tenantId, clientId);
    if (client.status === 'departed') return skip('client-departed', clientId);

    // 3. The recipients.
    const recipients = await subscribedContactsInTx(tx, tenantId, clientId, publicEvent);
    if (recipients.length === 0) return skip('no-subscriber', clientId);

    // 4. The daily cap (A5) — the database's clock, every status.
    const counts = await clientEmailCountsTodayInTx(tx, tenantId, clientId);
    if (counts[template] >= CLIENT_EMAIL_DAILY_CAP) {
      this.warnCapOnce(tenantId, clientId, template);
      return skip('over-cap', clientId);
    }

    // 5. The labels, then the params key by key.
    const names = {
      tenantName: await getTenantNameInTx(tx, tenantId),
      clientName: client.name,
      replyTo: client.emailReplyTo ?? null,
    };
    let params: ClientReceiptEmailParams | ClientDispatchEmailParams | ClientShipmentDocumentEmailParams | ClientDocumentsNeededEmailParams;
    if (packedOrderId !== null) {
      // Story 4-6a (A20, A36, A47) — the gate read AT DELIVERY (a reminder
      // about something already recorded would be wrong — the deliberate
      // exception to "facts frozen at the event"). Contained: any
      // non-transient fault acks without a row.
      let read: Awaited<ReturnType<OutboundFacade['consignmentGateOfOrderInTx']>>;
      try {
        // In a SAVEPOINT: a non-transient database error rolls back to it, so
        // the outer transaction stays usable and the skip commits cleanly.
        read = await tx.transaction((sp) =>
          this.outbound.consignmentGateOfOrderInTx(sp as unknown as TenantTx, tenantId, packedOrderId, istDateOf(new Date(clientEmailClock.now()).toISOString())),
        );
      } catch (err) {
        if (isTransientDbError(err)) throw err;
        return skip('gate-unreadable', clientId);
      }
      // The order is gone (it cannot reach here with a client and no row, but never mail it).
      if (read === null) return skip('not-open', clientId);
      const status = read.facts.order.status;
      if (status !== 'accepted' && status !== 'ready_to_dispatch') return skip('not-open', clientId);
      const gate = read.gate;
      if (!gate.blocking) return skip('not-blocking', clientId);
      const warehouseName = await getWarehouseNameInTx(tx, tenantId, read.facts.order.warehouseId);
      params = buildDocumentsNeededEmailParams(
        {
          orderId: packedOrderId,
          orderRef: read.facts.label,
          state: gate.state as 'missing' | 'eway-required' | 'eway-expired',
          requiredBecause: gate.requiredBecause,
          nationalThresholdPaise: read.nationalThresholdPaise,
          recordThresholdPaise: read.facts.live?.thresholdPaise === undefined || read.facts.live?.thresholdPaise === null ? null : Number(read.facts.live.thresholdPaise),
          ewayValidUntil: read.facts.live?.ewayValidUntil ?? null,
        },
        { ...names, warehouseName },
      );
    } else if (document !== null) {
      const facts = await this.outbound.shipmentDocumentEmailFactsInTx(tx, tenantId, document);
      if (facts === null) return skip('document-gone', clientId);
      params = buildShipmentDocumentEmailParams(document, facts, names);
    } else if (receipt !== null) {
      const warehouseName = await getWarehouseNameInTx(tx, tenantId, receipt.warehouseId);
      const poCodes = receipt.poId === null ? new Map<string, string>() : await this.inbound.poCodesByIdsInTx(tx, tenantId, [receipt.poId]);
      const skus = await this.catalog.skuLabelsInTx(tx, tenantId, receipt.lines.map((line) => line.skuId));
      params = buildReceiptEmailParams(receipt, {
        ...names,
        warehouseName,
        poCode: receipt.poId === null ? null : (poCodes.get(receipt.poId) ?? null),
        skus,
        qcHeldLines: qcHeldLinesOf(event.payload),
      });
    } else {
      const fact = dispatch!;
      const warehouseName = await getWarehouseNameInTx(tx, tenantId, fact.warehouseId);
      const skus = await this.catalog.skuLabelsInTx(tx, tenantId, fact.lines.map((line) => line.skuId));
      const kitParentLineIds = await this.outbound.kitParentLineIdsInTx(tx, tenantId, fact.lines.map((line) => line.orderLineId));
      // Story 4-6a (A20) — the version the goods left under (stamped, immutable).
      const stamped = (await dispatchedConsignmentRecordsOfOrdersInTx(tx, tenantId, [fact.orderId], new Map([[fact.orderId, fact.dispatchedAt]]))).get(fact.orderId) ?? null;
      params = buildDispatchEmailParams(fact, { ...names, warehouseName, skus, kitParentLineIds }, stamped);
    }

    // 6. One row per recipient; a re-delivered event finds every key taken.
    let queued = 0;
    let deduped = 0;
    for (const recipient of recipients) {
      const dedupeKey = clientEmailDedupeKey(template, subjectId, recipient.email);
      const row =
        template === 'client-receipt'
          ? await queueClientEmailInTx(tx, {
              tenantId,
              clientId,
              template,
              to: recipient.email,
              dedupeKey,
              params: params as ClientReceiptEmailParams,
              // Story 2-9a (decision 17) — every receipt email carries its GRN,
              // rendered at send time (no per-client switch).
              attachment: { kind: 'grn-pdf', ref: subjectId },
            })
          : template === 'client-shipment-document'
            ? await queueClientEmailInTx(tx, {
                tenantId,
                clientId,
                template,
                to: recipient.email,
                dedupeKey,
                params: params as ClientShipmentDocumentEmailParams,
                // Story 4-4a (D3) — the stored file, read and attached at send time.
                attachment: { kind: 'stored-file', ref: subjectId },
              })
            : template === 'client-documents-needed'
              ? await queueClientEmailInTx(tx, {
                  tenantId,
                  clientId,
                  template,
                  to: recipient.email,
                  dedupeKey,
                  params: params as ClientDocumentsNeededEmailParams,
                })
              : await queueClientEmailInTx(tx, {
                tenantId,
                clientId,
                template,
                to: recipient.email,
                dedupeKey,
                params: params as ClientDispatchEmailParams,
                // Story 4-5a (A20) — every dispatch email carries the order's
                // packing slip, rendered at send time (client audience).
                attachment: { kind: 'packing-slip-pdf', ref: subjectId },
              });
      if (row === null) {
        deduped += 1;
      } else {
        queued += 1;
        this.logger.log(`client-email.queued type=${event.type} tenant=${tenantId} client=${clientId} template=${template} message=${row.id} status=${row.status}`);
      }
    }
    return { kind: 'queued', queued, deduped };
  }

  /** One warn per (tenant, client, template, IST day) in this process. */
  private warnCapOnce(tenantId: string, clientId: string, template: string): void {
    const day = istDateOf(new Date(clientEmailClock.now()).toISOString());
    if (day !== this.capWarnedDay) {
      this.capWarned.clear();
      this.capWarnedDay = day;
    }
    const key = `${tenantId}:${clientId}:${template}`;
    if (this.capWarned.has(key)) return;
    this.capWarned.add(key);
    this.logger.warn(
      `client-email.over-cap tenant=${tenantId} client=${clientId} template=${template} — the daily limit of ${CLIENT_EMAIL_DAILY_CAP} is reached; later events today are not emailed`,
    );
  }
}
