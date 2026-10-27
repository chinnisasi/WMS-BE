import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { returnDispositions, returnHoldSettlements, returnReceiptLines } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { QcFacade } from '../inbound/qc.facade';
import { dispositionDataFault } from './disposition-split';

/** The two QC events that close a hold (a release; 2-8a's inspection). */
export const HOLD_SETTLEMENT_EVENTS = ['qc_hold.released', 'qc_hold.inspected'] as const;

/** What one delivery did — returned for the suites (the bus ignores it). */
export type HoldSettlementOutcome = 'not-a-return-hold' | 'settled' | 'already-settled' | 'hold-still-open' | 'unroutable' | 'data-fault';

/**
 * Story 4-7a (A1) — the returns module's hold-settlement subscriber. A return
 * hold is QC's row; when QC closes it (`qc_hold.released`, or 2-8a's
 * `qc_hold.inspected`) the units it returns to RETURNS are awaiting a
 * disposition again, and this handler adds them back to the receipt line's
 * `open_qty` — once.
 *
 * - **Routing by hold id, never by payload `kind`:** the payload's `holdId` is
 *   looked up in `return_dispositions.qc_hold_id`; no row means not a return
 *   hold, and the delivery acks (every manual and receipt hold lands here
 *   too).
 * - **Its own tenant transaction** (never a caller's), in order: the
 *   disposition → the receipt line `FOR UPDATE` → QC's own record of the
 *   hold (`QcFacade.returnHoldOutcomeInTx` — the quantities are NEVER the
 *   payload's) → the settlement row, `ON CONFLICT (tenant_id, qc_hold_id) DO
 *   NOTHING` → only when that insert inserted, `open_qty += returned`.
 *   At-least-once delivery therefore settles exactly once.
 * - **Postures** (the `invoicing/delivery.ts` shape): a malformed payload or
 *   a DATA fault (a typed 4xx/`data-fault` problem — no retry can fix it)
 *   logs and ACKS: the bus runs the notifications handler after this one on
 *   the same event and skips it on a throw, so a rethrown data fault would
 *   starve the `qc-hold` resolution. A transient failure (anything else)
 *   logs and RETHROWS — the relay re-drains with backoff.
 */
@Injectable()
export class ReturnHoldSettlementHandler implements OnModuleInit {
  private readonly logger = new Logger(ReturnHoldSettlementHandler.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QcFacade) private readonly qc: QcFacade,
  ) {}

  onModuleInit(): void {
    for (const type of HOLD_SETTLEMENT_EVENTS) {
      this.eventBus.subscribe(type, async (event) => {
        await this.deliver(event);
      });
    }
  }

  /** One delivery attempt (a relay publish is one invocation, at-least-once). */
  async deliver(event: DomainEvent): Promise<HoldSettlementOutcome> {
    if (!(HOLD_SETTLEMENT_EVENTS as readonly string[]).includes(event.type)) return 'unroutable';
    const holdId = (event.payload as { holdId?: unknown } | null)?.holdId;
    if (typeof holdId !== 'string' || !UUID_RE.test(holdId)) {
      this.logger.error(`unroutable ${event.type} ${event.eventId} (malformed holdId) — acking, not retrying`);
      return 'unroutable';
    }
    try {
      return await withTenantTransaction(this.db, event.tenantId, async (tx) => {
        const dispositions = await tx
          .select({
            id: returnDispositions.id,
            clientId: returnDispositions.clientId,
            lineId: returnDispositions.returnReceiptLineId,
            qty: returnDispositions.qty,
          })
          .from(returnDispositions)
          .where(and(eq(returnDispositions.tenantId, event.tenantId), eq(returnDispositions.qcHoldId, holdId.toLowerCase())))
          .limit(1);
        const disposition = dispositions[0];
        if (disposition === undefined) return 'not-a-return-hold' as const;
        const lines = await tx
          .select({ id: returnReceiptLines.id })
          .from(returnReceiptLines)
          .where(and(eq(returnReceiptLines.tenantId, event.tenantId), eq(returnReceiptLines.id, disposition.lineId)))
          .for('update');
        if (lines[0] === undefined) throw dispositionDataFault(`Return disposition "${disposition.id}" names a receipt line that does not exist.`);
        const outcome = await this.qc.returnHoldOutcomeInTx(tx, event.tenantId, holdId.toLowerCase());
        if (outcome === null) throw dispositionDataFault(`Return disposition "${disposition.id}" names QC hold "${holdId}", which does not exist.`);
        if (outcome.status === 'open') {
          // A closing event whose hold reads open: the event outran nothing it
          // can wait for (the close committed with the event) — a data fault.
          this.logger.error(`${event.type} ${event.eventId}: return hold ${holdId} still reads open — acking`);
          return 'hold-still-open' as const;
        }
        if (outcome.heldMilli !== Number(disposition.qty) || outcome.returnedMilli + outcome.failedMilli !== outcome.heldMilli) {
          throw dispositionDataFault(
            `QC hold "${holdId}" held ${outcome.heldMilli} (returned ${outcome.returnedMilli}, failed ${outcome.failedMilli}) but its return disposition quarantined ${Number(disposition.qty)}.`,
          );
        }
        const inserted = await tx
          .insert(returnHoldSettlements)
          .values({
            id: uuidv7(),
            tenantId: event.tenantId,
            clientId: disposition.clientId,
            dispositionId: disposition.id,
            qcHoldId: holdId.toLowerCase(),
            status: outcome.status,
            heldQty: outcome.heldMilli,
            returnedQty: outcome.returnedMilli,
            failedQty: outcome.failedMilli,
            settledAt: nowIso(),
          })
          .onConflictDoNothing({ target: [returnHoldSettlements.tenantId, returnHoldSettlements.qcHoldId] })
          .returning({ id: returnHoldSettlements.id });
        if (inserted.length === 0) return 'already-settled' as const;
        if (outcome.returnedMilli > 0) {
          await tx
            .update(returnReceiptLines)
            .set({ openQty: sql`${returnReceiptLines.openQty} + ${outcome.returnedMilli}::bigint` })
            .where(and(eq(returnReceiptLines.tenantId, event.tenantId), eq(returnReceiptLines.id, disposition.lineId)));
        }
        return 'settled' as const;
      });
    } catch (err) {
      if (err instanceof ProblemException && (err.getStatus() < 500 || problemCode(err) === 'data-fault')) {
        this.logger.error(`${event.type} ${event.eventId}: settling return hold ${holdId} hit a data fault — acking: ${err.message}`);
        return 'data-fault';
      }
      this.logger.error(`${event.type} ${event.eventId}: settling return hold ${holdId} failed — retrying via relay`);
      throw err;
    }
  }
}

function problemCode(err: ProblemException): string | null {
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null;
}
