import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { channelMappings, integrations } from '../../shared/db/schema';
import type { Integration, IntegrationCallStatus } from '../../shared/db/schema';
import { auditEvents } from '../../shared/db/schema';
import { nowIso } from '../../shared/primitives/time';
import { ulid, uuidv7 } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { CatalogFacade } from '../catalog/catalog.facade';
import { getClientLabelsInTx } from '../clients/clients.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import type { CreateOrderCommand } from '../outbound/outbound.facade';
import { CONNECTION_COLUMNS } from './channels.view';
import { ChannelsPublishService } from './channels.publish';
import {
  channelConnectionNotFound,
  ingestConfigInvalid,
  ingestMixedClient,
  ingestWarehouseUnset,
  orderActorUnprivileged,
  orderBackorderRejected,
  cancellationUnresolved,
  validationFailedIngest,
} from './channels.errors';
import type { ParsedChannelCancellation, ParsedChannelOrder } from './channel-registry';

/**
 * The webhook ingest command (story 7.2, RD-1/RD-2/RD-3/RD-8/RD-9): the
 * VERIFIED + PARSED delivery is turned into THE order path's own commands —
 * `OutboundFacade.createOrder` (`source: 'ingested'`) and `cancelOrder` —
 * behind the connection's configuration and the mapping resolution.
 *
 * The class never sees the raw channel payload: the controller verified the
 * signature (the sender) and ran the registry's parse arm (the shape); what
 * arrives here is already the normalized `{orderRef, destination, lines}`
 * vocabulary. From there the flow is the command skeleton's, per delivery:
 *
 *   connection read (404) → config guards (the unset-warehouse and
 *   config-invalid refusals) → mapping resolution (`unmapped` and
 *   deleted-SKU refusals) → the outbound command with the connection's
 *   arms (actor = `connected_by` — RD-2, policy = `backorder_policy` —
 *   RD-3, warehouse = `ingest_warehouse_id` — RD-4) → meter row (
 *   `integration_calls` kind `order-ingest`, the OUTCOME status — RD-9:
 *   refused outcomes meter as statuses, never as health/breaker pressure).
 *
 * Idempotency: the ingest mints its OWN per-delivery ULID key (Idempotency-
 * Key is NOT a webhook input — RD-9); re-delivery safety rides RD-1's dedup
 * (the channel order ref is the identity), so both deliveries answer the
 * same order whether sequential (the pre-check) or concurrent (the partial
 * unique + `resolveDedupLoser`).
 */
@Injectable()
export class ChannelsIngestCommand {
  private readonly logger = new Logger('ChannelsIngest');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(ChannelsPublishService) private readonly publish: ChannelsPublishService,
  ) {}

  /**
   * One verified `orders` delivery → the order. Answers
   * `{outcome, orderId}` — `accepted` / `backordered` (a shortfall under
   * the connection's `accept` policy) / `replayed` (the order existed
   * before this delivery — RD-1's eternal dedup: a redelivery of a
   * since-cancelled order answers `replayed` with the stored order too).
   */
  async ingestOrderDelivery(args: {
    tenantId: string;
    connectionId: string;
    parsed: ParsedChannelOrder;
  }): Promise<{ outcome: 'accepted' | 'backordered' | 'replayed'; orderId: string }> {
    const { tenantId, connectionId, parsed } = args;
    const startedAt = Date.now();

    // ── the connection's face + config (RD-4) ─────────────────────────────
    const connection = await this.readConnection(tenantId, connectionId);
    if (connection === null) {
      throw channelConnectionNotFound();
    }
    if (connection.ingestWarehouseId === null) {
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'warehouse-unset',
        latencyMs: Date.now() - startedAt,
        error: 'the connection has no ingest warehouse configured',
      });
      throw ingestWarehouseUnset(connectionId);
    }
    // A warehouse set but since deleted: NOT a 404 (a 404 would tell the
    // channel the DELIVERY is wrong — the CONFIG is) — the typed 422 NACK
    // (RD-4, triage #32).
    try {
      await withTenantTransaction(this.db, tenantId, (tx) =>
        assertWarehouseInTenant(tx, tenantId, connection.ingestWarehouseId!),
      );
    } catch (err) {
      if (err instanceof ProblemException && err.getStatus() === 404) {
        await this.publish.recordIngestOutcome(tenantId, connectionId, {
          status: 'config-invalid',
          latencyMs: Date.now() - startedAt,
          error: 'the configured ingest warehouse no longer exists',
        });
        throw ingestConfigInvalid(
          connectionId,
          'the configured ingest warehouse no longer exists — set another with the config PUT',
        );
      }
      throw err;
    }

    // ── mapping resolution (the delivery refuses WHOLE on the first miss) ─
    const mappings = new Map<string, string>();
    for (const row of await this.readMappings(tenantId, connectionId)) {
      mappings.set(row.externalRef, row.skuId);
    }
    const lines: { skuId: string; quantity: number }[] = [];
    const skuIds = new Set<string>();
    for (const line of parsed.lines) {
      const skuId = mappings.get(line.externalRef);
      if (skuId === undefined) {
        await this.publish.recordIngestOutcome(tenantId, connectionId, {
          status: 'unmapped',
          latencyMs: Date.now() - startedAt,
          error: `no SKU is mapped for an external ref of this connection (first unmapped: "${line.externalRef.slice(0, 64)}")`,
        });
        throw validationFailedIngest(
          `The order carries external ref "${line.externalRef}" which this channel connection has no SKU mapping for — map it with the mappings PUT and the channel's retry lands it.`,
        );
      }
      lines.push({ skuId, quantity: line.quantity });
      skuIds.add(skuId);
    }
    // A mapped SKU deleted after the mapping set: the typed 422 (remediation
    // is the mappings PUT) — never a bare 404.
    const skuClientIds = new Set<string>();
    for (const skuId of skuIds) {
      const sku = await this.catalog.findSku(tenantId, skuId);
      if (sku !== null) {
        skuClientIds.add(sku.clientId);
      }
      if (sku === null) {
        await this.publish.recordIngestOutcome(tenantId, connectionId, {
          status: 'config-invalid',
          latencyMs: Date.now() - startedAt,
          error: 'a mapped SKU of this connection no longer exists',
        });
        throw ingestConfigInvalid(
          connectionId,
          'a mapped SKU no longer exists — fix the mapping set with the mappings PUT',
        );
      }
    }
    // The replay label: was the order already on the books before THIS
    // delivery? The dedup machinery answers idempotency; this read answers
    // the outcome's honesty (a redelivery is `replayed`, a first delivery is
    // `accepted`/`backordered`). Read BEFORE the mixed-client pre-check:
    // story 21-2b — a redelivery of an accepted order must replay through
    // the order command even if the mappings have changed since.
    const prior = await this.outbound.findOrderByChannelRef(
      tenantId,
      connectionId,
      parsed.orderRef,
    );

    // Story 21-2b: an order is for ONE client, derived from its SKUs. A
    // FIRST delivery whose mapped SKUs span clients is a mapping problem the
    // channel's retry cannot fix — refused HERE as the typed 422 (remediate
    // with the mappings PUT), metered `validation-failed`, never the
    // transient `failed` a 409 from the order command would meter as.
    if (prior === null && skuClientIds.size > 1) {
      const labels = await withTenantTransaction(this.db, tenantId, (tx) =>
        getClientLabelsInTx(tx, tenantId, [...skuClientIds]),
      );
      const named = [...skuClientIds].map((id) => labels.get(id) ?? id).sort().join(', ');
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'validation-failed',
        latencyMs: Date.now() - startedAt,
        error: `the order's mapped SKUs belong to more than one client (${named})`,
      });
      throw ingestMixedClient(connectionId, `SKUs of more than one client (${named})`);
    }

    // ── the order command (the ONE acceptance path, 4-1's) ────────────────
    const command: CreateOrderCommand = {
      tenantId,
      // RD-2: the ingest actor is the connection's connected_by — the
      // command's DB role re-read is the authority (fail-closed).
      actorUserId: connection.connectedBy,
      warehouseId: connection.ingestWarehouseId,
      source: 'ingested',
      integrationId: connectionId,
      externalEventId: parsed.orderRef,
      ...(parsed.destination === undefined ? {} : { destination: parsed.destination }),
      lines,
      // RD-3: the connection's policy rides the command (default 'accept').
      ...(connection.backorderPolicy === 'reject' ? { backorderPolicy: 'reject' } : {}),
    };
    // RD-9: the ingest mints its own per-delivery key — Idempotency-Key is
    // NOT a webhook input; replay safety is RD-1's dedup on the order ref.
    const idempotencyKey = ulid();

    try {
      const snapshot = await this.outbound.createOrder(command, idempotencyKey);
      const outcome: 'accepted' | 'backordered' | 'replayed' =
        prior !== null
          ? 'replayed'
          : snapshot.order.lines.some((line) => line.status === 'backordered')
            ? 'backordered'
            : 'accepted';
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: outcome,
        latencyMs: Date.now() - startedAt,
        error: null,
      });
      return { outcome, orderId: snapshot.order.id };
    } catch (err) {
      if (err instanceof ProblemException) {
        throw await this.mapIngestRejection(tenantId, connectionId, startedAt, err);
      }
      // Non-problem faults (the store's 503 rides ProblemException; anything
      // else is unexpected) meter `failed` and propagate — NACK either way.
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : 'unexpected ingest failure',
      }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * One verified `cancellations` delivery (RD-8): `released` when the
   * order was `accepted` and its holds are gone; `ignored` (still 200)
   * when the order resolved but is already cancelled or past `accepted`;
   * unknown → the 503 `cancellation-unresolved` NACK (the channel retries —
   * the create/cancel race self-heals on the retry after the create
   * commits).
   */
  async ingestCancellationDelivery(args: {
    tenantId: string;
    connectionId: string;
    parsed: ParsedChannelCancellation;
  }): Promise<{ outcome: 'released' | 'ignored' }> {
    const { tenantId, connectionId, parsed } = args;
    const startedAt = Date.now();

    const connection = await this.readConnection(tenantId, connectionId);
    if (connection === null) {
      throw channelConnectionNotFound();
    }

    const order = await this.outbound.findOrderByChannelRef(
      tenantId,
      connectionId,
      parsed.orderRef,
    );
    if (order === null) {
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'cancellation-unresolved',
        latencyMs: Date.now() - startedAt,
        error: 'no order for this connection carries the ref (yet)',
      });
      throw cancellationUnresolved(connectionId, parsed.orderRef);
    }
    // RD-8: a cancellation applies ONLY to `accepted` — already cancelled,
    // packed or dispatched orders answer `ignored` (still 200, the channel
    // need not retry): the channel's truth (cancelled) and ours already
    // agree or the order's units have physically left.
    if (order.status !== 'accepted') {
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'ignored',
        latencyMs: Date.now() - startedAt,
        error: `the order reads "${order.status}" — the cancellation records as ignored`,
      });
      // RD-8 (review patch P10): an `ignored` outcome is still a
      // cancellation decision — it lands in the audit trail as well as the
      // meter (the released path's audit rides `cancelOrder`'s own row).
      await this.recordCancellationIgnoredAuditSafe(tenantId, connection.connectedBy, order.id, parsed.orderRef);
      return { outcome: 'ignored' };
    }
    try {
      // RD-2's actor rule applies here too (the command's DB re-read is the
      // authority); the audit row of a released cancellation carries
      // `connected_by` — the channel source.
      await this.outbound.cancelOrder(
        { tenantId, actorUserId: connection.connectedBy, orderId: order.id },
        ulid(),
      );
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'released',
        latencyMs: Date.now() - startedAt,
        error: null,
      });
      return { outcome: 'released' };
    } catch (err) {
      if (err instanceof ProblemException) {
        // A drawn-pick / committed-hold refusal: the order is no longer
        // pre-pick stock — recorded as `ignored` (RD-8; the meter row
        // carries the refusal detail); the 403 maps fail-closed as for
        // orders; everything else refuses the delivery verbatim.
        const mapped = await this.mapCancellationRejection(
          tenantId,
          connectionId,
          startedAt,
          err,
          connection.connectedBy,
          order,
          parsed.orderRef,
        );
        if (mapped !== null) {
          return mapped;
        }
        throw err;
      }
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : 'unexpected cancellation failure',
      }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * The order ingest's rejection → meter status + wire refusal mapping
   * (RD-9: every refused outcome meters a STATUS; row 1's arms stay exact).
   */
  private async mapIngestRejection(
    tenantId: string,
    connectionId: string,
    startedAt: number,
    err: ProblemException,
  ): Promise<ProblemException> {
    const code = (err.getResponse() as { code: string }).code;
    const latencyMs = Date.now() - startedAt;
    let status: IntegrationCallStatus;
    let mapped: ProblemException | null = null;
    if (err.getStatus() === 403 && code === 'role-denied') {
      // RD-2: the actor's role is re-read per delivery — a lost
      // `orders.manage` fails closed on the connection's actor.
      status = 'actor-unprivileged';
      mapped = orderActorUnprivileged(connectionId);
    } else if (code === 'order-backorder-rejected') {
      status = 'rejected';
      mapped = orderBackorderRejected(connectionId);
    } else if (code === 'order-source-conflict') {
      status = 'conflict';
    } else if (code === 'ingest-warehouse-unset') {
      status = 'warehouse-unset';
    } else if (code === 'ingest-config-invalid') {
      status = 'config-invalid';
    } else if (code === 'mixed-client') {
      // Story 21-2b: the order command's mixed-client refusal (a kit whose
      // components belong to another client — the mapping pre-check catches
      // plain lines) is the same mapping/catalog problem: the same typed 422
      // as the pre-check, metered `validation-failed`, never a transient
      // `failed`.
      status = 'validation-failed';
      mapped = ingestMixedClient(connectionId, 'SKUs (or kit components) of more than one client');
    } else if (code === 'validation-failed') {
      status = 'validation-failed';
    } else if (err.getStatus() === 503) {
      // The grant store failed closed — nothing written; the channel's
      // retry lands inside the dedup (row 1's NACK arm).
      status = 'failed';
    } else {
      status = 'failed';
    }
    await this.publish.recordIngestOutcome(tenantId, connectionId, {
      status,
      latencyMs,
      error: err.message,
    }).catch(() => undefined);
    return mapped ?? err;
  }

  /**
   * The cancellation ingest's refusal mapping (RD-8): the drawn/committed
   * class answers `ignored`; a lost actor fails closed; `null` = rethrow
   * verbatim.
   */
  private async mapCancellationRejection(
    tenantId: string,
    connectionId: string,
    startedAt: number,
    err: ProblemException,
    actorUserId: string,
    order: { readonly id: string },
    orderRef: string,
  ): Promise<{ outcome: 'released' | 'ignored' } | null> {
    const latencyMs = Date.now() - startedAt;
    const code = (err.getResponse() as { code: string }).code;
    if (err.getStatus() === 403 && code === 'role-denied') {
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'actor-unprivileged',
        latencyMs,
        error: err.message,
      }).catch(() => undefined);
      throw orderActorUnprivileged(connectionId);
    }
    if (err.getStatus() === 409) {
      // A cancellation that can no longer apply (a mid-flight status change,
      // committed holds, drawn pick lines — cancelOrder's whole 409 class):
      // recorded as `ignored` — the order's units have already moved.
      await this.publish.recordIngestOutcome(tenantId, connectionId, {
        status: 'ignored',
        latencyMs,
        error: err.message,
      }).catch(() => undefined);
      // RD-8 (review patch P10): the 409-class `ignored` decision lands in
      // the audit trail as well as the meter.
      await this.recordCancellationIgnoredAuditSafe(tenantId, actorUserId, order.id, orderRef);
      return { outcome: 'ignored' };
    }
    await this.publish.recordIngestOutcome(tenantId, connectionId, {
      status: 'failed',
      latencyMs,
      error: err.message,
    }).catch(() => undefined);
    return null;
  }

  /**
   * The `ignored` cancellation decision's audit row (RD-8 — "every
   * cancellation outcome lands in the meter … and an audit row", review
   * patch P10: both ignored branches write it). The action
   * `order.cancellation_ignored`, the actor `connected_by`, the ref the
   * channel named — nothing secret. Best-effort (a meter row's own
   * posture): an audit write fault must not fail a delivery that already
   * answered 200.
   */
  private async recordCancellationIgnoredAuditSafe(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    orderRef: string,
  ): Promise<void> {
    try {
      await withTenantTransaction(this.db, tenantId, (tx) =>
        tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorUserId,
          action: 'order.cancellation_ignored',
          targetType: 'order',
          targetId: orderId,
          reference: orderRef,
          occurredAt: nowIso(),
        }),
      );
    } catch (err) {
      this.logger.error(
        `ignored-cancellation audit row failed to write (non-blocking): ${String(err)}`,
      );
    }
  }

  /** The connection's public face (the sealed blob rides nothing here). */
  private async readConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<Omit<Integration, 'credentialSealed'> | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = (await tx
        .select(CONNECTION_COLUMNS)
        .from(integrations)
        .where(eq(integrations.id, connectionId))
        .limit(1)) as Omit<Integration, 'credentialSealed'>[];
      return rows[0] ?? null;
    });
  }

  /** The mapping rows for one connection (the ingest's resolution table). */
  private async readMappings(
    tenantId: string,
    connectionId: string,
  ): Promise<{ externalRef: string; skuId: string }[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ externalRef: channelMappings.externalRef, skuId: channelMappings.skuId })
        .from(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, tenantId),
            eq(channelMappings.integrationId, connectionId),
          ),
        ),
    );
  }
}