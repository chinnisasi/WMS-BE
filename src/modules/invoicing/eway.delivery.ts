import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { ewayBills, invoiceLines, invoices } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { ArithmeticOverflowError, type SupplyType } from './arith';
import { INVOICE_ISSUED_EVENT } from './events';
import { consignmentValuePaise, ewayRequired, istDateOf, thresholdFor } from './eway-threshold';

/**
 * The e-way queue (story 8-2b): subscribes to `invoice.issued` and queues a
 * `pending` e-way bill when the issued invoice's consignment value exceeds
 * the threshold in force on its IST issue date.
 *
 * Postures (the `delivery.ts` template — the bus stops at the first throw,
 * and 21-5 will subscribe to `invoice.issued` too):
 *  - only `invoiceId` is decoded; every other payload field is untrusted and
 *    the invoice is RE-READ — it must be `issued` with an `issued_at`;
 *  - a malformed payload, an unknown or not-issued invoice, or a
 *    deterministic data fault ACKS and logs;
 *  - only a transient fault (a DB outage, a deadlock) rethrows to the relay.
 *
 * Idempotent through `eway_bills_invoice_unique` (`ON CONFLICT DO NOTHING`):
 * a redelivery writes nothing. Never touches dispatch or the invoice.
 * Event-driven writes are not audited (no actor — the `delivery.ts` rule).
 */
@Injectable()
export class EwayDeliveryHandler implements OnModuleInit {
  private readonly logger = new Logger(EwayDeliveryHandler.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(INVOICE_ISSUED_EVENT, (event) => this.deliver(event));
  }

  async deliver(event: DomainEvent): Promise<void> {
    if (event.type !== INVOICE_ISSUED_EVENT) return;
    const invoiceId = decodeInvoiceId(event.payload);
    if (invoiceId === null) {
      this.logger.error(`invoice.issued ${event.eventId}: malformed payload (no invoiceId) — acking, not retrying`);
      return;
    }
    try {
      await withTenantTransaction(this.db, event.tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, event.tenantId), eq(invoices.id, invoiceId)))
          .limit(1);
        const invoice = rows[0];
        if (
          invoice === undefined ||
          invoice.status !== 'issued' ||
          invoice.issuedAt === null ||
          invoice.originGstin === null ||
          (invoice.supplyType !== 'intra' && invoice.supplyType !== 'inter')
        ) {
          this.logger.warn(`invoice.issued ${event.eventId}: invoice ${invoiceId} is not an issued invoice — acking, nothing queued`);
          return;
        }
        const lines = await tx
          .select()
          .from(invoiceLines)
          .where(and(eq(invoiceLines.tenantId, event.tenantId), eq(invoiceLines.invoiceId, invoiceId)));
        const value = consignmentValuePaise(
          lines.map((line) => ({
            gstBps: line.gstBps,
            taxablePaise: Number(line.taxablePaise),
            cgstPaise: Number(line.cgstPaise),
            sgstPaise: Number(line.sgstPaise),
            igstPaise: Number(line.igstPaise),
          })),
        );
        const threshold = await thresholdFor(tx, event.tenantId, {
          supplyType: invoice.supplyType as SupplyType,
          billFromState: invoice.originGstin.slice(0, 2),
          istDate: istDateOf(invoice.issuedAt),
        });
        if (!ewayRequired(value, threshold)) {
          this.logger.log(`invoice ${invoice.invoiceNo}: consignment value ${value} paise needs no e-way bill (${threshold.rule})`);
          return;
        }
        await tx
          .insert(ewayBills)
          .values({
            id: uuidv7(),
            tenantId: event.tenantId,
            invoiceId,
            originGstin: invoice.originGstin,
            status: 'pending',
            consignmentValuePaise: value,
            thresholdPaise: threshold.thresholdPaise!,
            thresholdRule: threshold.rule,
          })
          .onConflictDoNothing({ target: ewayBills.invoiceId });
        this.logger.log(`invoice ${invoice.invoiceNo}: e-way bill queued (value ${value} paise > ${threshold.rule} ${threshold.thresholdPaise})`);
      });
    } catch (err) {
      if (err instanceof ArithmeticOverflowError || (err instanceof ProblemException && err.getStatus() < 500)) {
        this.logger.error(`invoice.issued ${event.eventId}: e-way queueing for invoice ${invoiceId} hit a data fault — acking: ${(err as Error).message}`);
        return;
      }
      this.logger.error(`invoice.issued ${event.eventId}: e-way queueing for invoice ${invoiceId} failed — retrying via relay`);
      throw err;
    }
  }
}

/** The payload decode — the invoice id only; nothing else is trusted. */
function decodeInvoiceId(payload: Record<string, unknown>): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const invoiceId = (payload as { invoiceId?: unknown }).invoiceId;
  return typeof invoiceId === 'string' && UUID_RE.test(invoiceId) ? invoiceId : null;
}
