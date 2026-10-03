import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { ArithmeticOverflowError } from './arith';
import { InvoiceGenerator, InvoiceRaceLostError } from './generator';
import { INVOICE_ISSUED_EVENT, ORDER_DISPATCHED_EVENT } from './events';
import type { InvoiceIssuedPayload } from './events';

/**
 * The dispatch event's delivery handler (story 8-1). The outbox relay drains
 * `order.dispatched` rows (dispatch.command's in-tx append) and publishes
 * them through the routed event bus; THIS class is the subscriber that
 * auto-generates the invoice:
 *
 *   on `order.dispatched` — open the handler's OWN tenant transaction
 *   (never nest a caller's — the getPickTasksInTx pool rule) and run the
 *   generator's `generateCoreInTx` over the DERIVED facts (payload is used
 *   only for the order id); on the flip to `issued`, append `invoice.issued`
 *   in that same transaction;
 *
 *   postures — a malformed payload (a shape the arm cannot carry, e.g. a
 *   non-uuid order id) ACKS: a publisher bug is not a transient outage and
 *   the relay's retry cannot fix a shape (the channel delivery precedent).
 *   A DATA FAULT (unknown or undispatched order, an arithmetic overflow —
 *   deterministic, so no retry can fix it) logs and ACKS: the bus runs the
 *   7-2 channel writeback after this handler on the same event and skips it
 *   on a throw, so a rethrown data fault would starve the marketplace
 *   writeback until dead-letter (8-1 code review). A TRANSIENT failure (any
 *   other throw) logs and RETHROWS: the relay marks the row failed and
 *   re-drains with backoff, then dead-letters past its budget. A race loss (the manual command
 *   committed the invoice first) ACKS — the winner's row needs nothing from
 *   the loser.
 */
@Injectable()
export class InvoiceDeliveryHandler implements OnModuleInit {
  private readonly logger = new Logger(InvoiceDeliveryHandler.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InvoiceGenerator) private readonly generator: InvoiceGenerator,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(ORDER_DISPATCHED_EVENT, (event) => this.deliver(event));
  }

  /** One delivery attempt (a relay publish is one invocation, at-least-once). */
  async deliver(event: DomainEvent): Promise<void> {
    if (event.type !== ORDER_DISPATCHED_EVENT) {
      return;
    }
    const orderId = decodeOrderId(event.payload);
    if (orderId === null) {
      this.logger.error(
        `unroutable dispatch event ${event.eventId} (malformed payload) — acking, not retrying`,
      );
      return;
    }

    try {
      await withTenantTransaction(this.db, event.tenantId, async (tx) => {
        const outcome = await this.generator.generateCoreInTx(tx, event.tenantId, orderId, []);

        if (outcome.firstIssuance) {
          const payload: InvoiceIssuedPayload = {
            invoiceId: outcome.invoiceId,
            orderId: outcome.orderId,
            warehouseId: outcome.warehouseId,
            invoiceNo: outcome.invoiceNo!,
            fyLabel: outcome.fyLabel!,
            revision: outcome.revision,
            subtotalPaise: outcome.subtotalPaise,
            gstPaise: outcome.gstPaise,
            totalPaise: outcome.totalPaise,
          };
          await this.outbox.append(tx, {
            messageId: uuidv7(),
            tenantId: event.tenantId,
            type: INVOICE_ISSUED_EVENT,
            occurredAt: canonicalInstant(nowIso()),
            payload: { ...payload },
          });
        }
        this.logger.log(
          `invoice ${outcome.invoiceNo ?? '(awaiting-data)'} for order ${orderId} ` +
            (outcome.contentChanged ? `written at revision ${outcome.revision}` : 're-derived identical, no write'),
        );
      });
    } catch (err) {
      if (err instanceof InvoiceRaceLostError) {
        // The manual command committed the invoice first; the winner's row
        // needs nothing from the event — ack.
        this.logger.log(`dispatch ${event.eventId}: invoice for order ${orderId} committed concurrently — acking`);
        return;
      }
      if (isDataFault(err)) {
        // A DETERMINISTIC failure (an unknown/undispatched order, an
        // arithmetic overflow from an absurd rate): every retry fails the
        // same way. `order.dispatched` has a second subscriber — the 7-2
        // channel writeback, which the bus runs AFTER this handler and skips
        // on a throw — so rethrowing would starve the marketplace writeback
        // until the row dead-letters. ACK and log loudly; the operator's
        // `POST /invoices` is the recovery path once the data is fixed.
        this.logger.error(
          `dispatch ${event.eventId}: invoice generation for order ${orderId} hit a data fault — acking, fix the data and regenerate: ${(err as Error).message}`,
        );
        return;
      }
      this.logger.error(`dispatch ${event.eventId}: invoice generation for order ${orderId} failed — retrying via relay`);
      throw err; // the relay's retry budget carries the backoff
    }
  }
}

/**
 * The payload decode — ids only. The dispatch event's payload is
 * `{ dispatch: { orderId, … } }` (dispatch.command's append); this handler
 * re-derives EVERYTHING else from the tables (the never-trusts-the-payload
 * rule). A non-uuid order id is a malformed publication (ack, never
 * retried — the channel delivery's epic-7 retro D9 posture).
 */
/**
 * A failure no retry can fix: a client-class problem (4xx — not-found,
 * order-not-dispatched) or the arithmetic's typed overflow. Everything else
 * (a DB outage, a deadlock, a 5xx problem) is transient and rethrows.
 */
function isDataFault(err: unknown): boolean {
  if (err instanceof ArithmeticOverflowError) return true;
  return err instanceof ProblemException && err.getStatus() < 500;
}

function decodeOrderId(payload: Record<string, unknown>): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const dispatch = (payload as { dispatch?: unknown }).dispatch;
  if (typeof dispatch !== 'object' || dispatch === null) {
    return null;
  }
  const orderId = (dispatch as { orderId?: unknown }).orderId;
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
    return null;
  }
  return orderId;
}