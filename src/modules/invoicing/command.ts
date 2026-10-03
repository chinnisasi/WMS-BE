import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InvoiceGenerator, InvoiceRaceLostError } from './generator';
import type { RateOverride } from './generator';
import { INVOICE_ISSUED_EVENT } from './events';
import type { InvoiceIssuedPayload } from './events';
import { InvoicingFacade } from './facade';
import type { InvoiceSnapshot } from './view';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The discriminator that keeps this command's idempotency fingerprint out of
 * every sibling command's space (the `outbound.dispatch` precedent — it is
 * required and not decorative).
 */
const INVOICE_COMMAND_KIND = 'invoicing.generate';

// ── command inputs ───────────────────────────────────────────────────────────

/** One line rate override the operator sends with a regenerate. */
export interface InvoiceRateInput {
  readonly orderLineId: string;
  readonly ratePaise: number;
}

export interface GenerateInvoiceCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly orderId: string;
  /**
   * The manual pricing arm: per-line rate overrides (paise per base unit),
   * which re-derive the invoice from the dispatch facts WITH these rates
   * frozen into the document. Empty on a plain regenerate (the carried
   * manual rates hold). Only ever priced lines are named; overrides ride
   * the SAME generate command — pricing IS a regenerate.
   */
  readonly rates?: readonly InvoiceRateInput[] | undefined;
}

/**
 * The manual generate/regenerate command (story 8-1): `invoice.generate`,
 * a tenant-session idempotent command on the bin-state.command skeleton.
 * The generate/regenerate are ONE command — the derivation (the generator's
 * `generateCoreInTx`) decides content; a regenerate is a second call over a
 * dispatched order, never a distinct verb.
 *
 * Order is load-bearing (IMPLEMENTATION-GUIDE):
 *   permission assert → replay lookup (before ALL validation, the lenient
 *   hash normalization behind it) → derivation → write → in-tx `invoice.issued`
 *   append ONLY on the flip to `issued` → audit row → idempotency key LAST.
 *
 * A `line-not-of-order` / `order-not-dispatched` / `not-found` refusal is
 * thrown here from the generator (the HTTP error arms); the idempotency key
 * is NOT written on a refused attempt (the attempt carried no state).
 */
@Injectable()
export class InvoicingCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InvoiceGenerator) private readonly generator: InvoiceGenerator,
    @Inject(InvoicingFacade) private readonly facade: InvoicingFacade,
  ) {}

  async generate(command: GenerateInvoiceCommand, idempotencyKey: string): Promise<InvoiceSnapshot> {
    // The hash normalizes BEFORE hashing: the rates list is order-insensitive
    // (a regenerate resending the same prices in a different order is the
    // SAME command, so the fingerprint sorts by orderLineId — the wave's
    // skuOrder precedent). The sort never throws; the shape checks run
    // inside the transaction, behind the permission assert and the replay
    // lookup (the skeleton's order).
    const rates = sortRates(command.rates);
    const payloadHash = hashCommandPayload({
      kind: INVOICE_COMMAND_KIND,
      orderId: command.orderId,
      rates,
    });

    try {
      return await this.attempt(command, idempotencyKey, rates, payloadHash);
    } catch (err) {
      if (!(err instanceof InvoiceRaceLostError)) {
        throw err;
      }
      // A concurrent generation (the event delivery, or a twin command)
      // committed the ONE invoice first and this attempt rolled back whole.
      // Run it ONCE more: the row now exists, so the retry takes the
      // regenerate path — the caller's rates apply, and the audit row and
      // idempotency key land as on any success. A second loss is impossible
      // (the unique row cannot be inserted twice), so a retry error is real.
      return this.attempt(command, idempotencyKey, rates, payloadHash);
    }
  }

  private async attempt(
    command: GenerateInvoiceCommand,
    idempotencyKey: string,
    rates: readonly RateOverride[],
    payloadHash: string,
  ): Promise<InvoiceSnapshot> {
    return withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx): Promise<InvoiceSnapshot> => {
        // Authority at command-service entry (Story 1.5): the role is
        // re-read from the DB in this same tenant transaction.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'invoice.generate',
        );

        // Replay FIRST — validation lives strictly behind it (the command
        // skeleton's rule; a re-sent command replays even when the facts
        // have since changed).
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return existing[0].responseSnapshot as InvoiceSnapshot;
        }

        assertRatesShape(rates);

        const outcome = await this.generator.generateCoreInTx(tx, command.tenantId, command.orderId, rates);

        // In-transaction outbox append (AD-7) — ONLY on the flip to
        // `issued`; a regenerate that keeps the invoice issued emits
        // nothing (the number is the document's, not the event's).
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
            tenantId: command.tenantId,
            type: INVOICE_ISSUED_EVENT,
            occurredAt: canonicalInstant(nowIso()),
            payload: { ...payload },
          });
        }

        // The audit row for the MANUAL path (the event-driven delivery
        // writes none — audit_events.actorUserId is NOT NULL and no actor
        // exists on an event).
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'invoice.generated',
          targetType: 'order',
          targetId: command.orderId,
          reference: idempotencyKey,
          occurredAt: canonicalInstant(nowIso()),
        });

        // Idempotency key LAST (the skeleton's tail) — replaying the
        // settled document byte-for-byte.
        const settled = await this.facade.getInvoiceForOrderInTx(tx, command.tenantId, command.orderId);
        if (settled === null) {
          // Unreachable (the generation just settled this row), but a null
          // snapshot must never be written as a replay.
          throw new ProblemException(
            'conflict',
            409,
            'Concurrent idempotent request',
            'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
          );
        }
        const snapshot: InvoiceSnapshot = { invoice: settled };
        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            // Concurrent duplicate of the same idempotent request — the
            // winner's response is authoritative; this request carries no
            // new state. Retry and replay.
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return snapshot;
      },
    );
  }
}

/**
 * The fingerprint-stable form of the rates: sorted by orderLineId, never
 * throwing (it runs BEFORE the replay lookup — `String()` keeps a malformed
 * id sortable so the refusal happens in `assertRatesShape`, behind replay).
 */
function sortRates(rates: readonly InvoiceRateInput[] | undefined): readonly RateOverride[] {
  if (rates === undefined) {
    return [];
  }
  return [...rates]
    .sort((a, b) => {
      const x = String(a.orderLineId);
      const y = String(b.orderLineId);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((rate) => ({ orderLineId: rate.orderLineId, ratePaise: rate.ratePaise }));
}

/** The rates' shape refusals — run inside the transaction, behind the replay lookup. */
function assertRatesShape(rates: readonly RateOverride[]): void {
  const seen = new Set<string>();
  for (const rate of rates) {
    if (
      typeof rate.orderLineId !== 'string' ||
      rate.orderLineId === '' ||
      !Number.isSafeInteger(rate.ratePaise) ||
      rate.ratePaise < 0
    ) {
      throw rateShapeInvalid();
    }
    if (seen.has(rate.orderLineId)) {
      throw rateShapeInvalid(`duplicate orderLineId "${rate.orderLineId}" in rates`);
    }
    seen.add(rate.orderLineId);
  }
}

function rateShapeInvalid(detailSuffix = ''): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Validation failed',
    `ratePaise must be a non-negative integer and orderLineId a non-empty string${detailSuffix ? ` (${detailSuffix})` : ''}.`,
  );
}