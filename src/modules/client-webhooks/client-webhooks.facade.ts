import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { webhookDeliveries, webhookEndpoints, webhookEvents } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor, type Page } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { clientNotFound, getClientsInTx } from '../clients/clients.facade';
import { webhookConfigFromEnv } from './webhook-config';
import { WebhookSender, newWebhookTick, type WebhookSendSummary, type WebhookTenantRun, type WebhookTick } from './webhook.sender';
import { missingDelivery, webhookEndpointNotFound } from './client-webhooks.command';
import { toDeliveryView, toEndpointView, type WebhookDeliveryView, type WebhookEndpointView } from './client-webhooks.views';
import { WEBHOOK_DELIVERY_STATUSES, type WebhookDeliveryStatus } from './webhook-rules';

export const WEBHOOK_DELIVERY_PAGE_DEFAULT = 50;
export const WEBHOOK_DELIVERY_PAGE_MAX = 200;

/** An endpoint as the panel lists it: the view plus its held backlog. */
export interface WebhookEndpointListEntry extends WebhookEndpointView {
  readonly heldCount: number;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryView {
  /** The exact bytes every attempt sends (A24 — staff download it when the lines were omitted). */
  readonly body: string;
}

/** `warnings` on the endpoint reads and writes (A4): `webhooks-unavailable` while the gateway is off. */
export function webhookWarnings(): ('webhooks-unavailable')[] {
  try {
    return webhookConfigFromEnv().gateway === 'https' ? [] : ['webhooks-unavailable'];
  } catch {
    return ['webhooks-unavailable'];
  }
}

/**
 * Story 5-2a — the client-webhooks module's reads and the sender's entry
 * points. Every read is staff-only and owner-only (`clients.manage` —
 * URLs, payloads and delivery outcomes are integration detail, A26), behind
 * `assertPermission` in its own tenant transaction, scoped to the client in
 * the path: an unknown endpoint and another client's are the same 404. A
 * soft-deleted endpoint stays readable (its deliveries too) until the
 * retention arm removes it, but is not listed.
 */
@Injectable()
export class ClientWebhooksFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WebhookSender) private readonly sender: WebhookSender,
  ) {}

  async listEndpoints(tenantId: string, actorUserId: string, clientId: string): Promise<WebhookEndpointListEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.authorise(tx, tenantId, actorUserId, clientId);
      const rows = await tx
        .select()
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.clientId, clientId), ne(webhookEndpoints.status, 'deleted')))
        .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));
      const held = rows.length === 0 ? [] : ((await tx.execute(sql`
        select endpoint_id::text as "endpointId", count(*)::int as "n" from webhook_deliveries
         where tenant_id = ${tenantId}::uuid and status = 'held' and endpoint_id = any(${sql.param(rows.map((row) => row.id))}::uuid[])
         group by endpoint_id
      `)) as unknown as { endpointId: string; n: number }[]);
      const heldBy = new Map(held.map((row) => [row.endpointId, Number(row.n)]));
      return rows.map((row) => ({ ...toEndpointView(row), heldCount: heldBy.get(row.id) ?? 0 }));
    });
  }

  async listDeliveries(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    endpointId: string,
    query: { readonly cursor?: string; readonly limit?: number; readonly status?: WebhookDeliveryStatus },
  ): Promise<Page<WebhookDeliveryView>> {
    const limit = Math.min(Math.max(query.limit ?? WEBHOOK_DELIVERY_PAGE_DEFAULT, 1), WEBHOOK_DELIVERY_PAGE_MAX);
    let after: { createdAt: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      try {
        after = decodeCursor(query.cursor);
      } catch {
        throw new ProblemException('validation-failed', 400, 'Malformed cursor', 'cursor is not a cursor this list issued.');
      }
      if (!UUID_RE.test(after.id) || Number.isNaN(Date.parse(after.createdAt))) {
        throw new ProblemException('validation-failed', 400, 'Malformed cursor', 'cursor is not a cursor this list issued.');
      }
    }
    if (query.status !== undefined && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(query.status)) {
      throw new ProblemException('validation-failed', 400, 'Invalid status', `status must be one of ${JSON.stringify(WEBHOOK_DELIVERY_STATUSES)}.`);
    }
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.authorise(tx, tenantId, actorUserId, clientId);
      await this.readEndpoint(tx, tenantId, clientId, endpointId);
      const rows = await tx
        .select({ delivery: webhookDeliveries, eventType: webhookEvents.eventType, subjectId: webhookEvents.subjectId })
        .from(webhookDeliveries)
        .innerJoin(webhookEvents, and(eq(webhookEvents.tenantId, webhookDeliveries.tenantId), eq(webhookEvents.id, webhookDeliveries.eventId)))
        .where(
          and(
            eq(webhookDeliveries.tenantId, tenantId),
            eq(webhookDeliveries.endpointId, endpointId),
            query.status === undefined ? undefined : eq(webhookDeliveries.status, query.status),
            after === null
              ? undefined
              : sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => toDeliveryView(row.delivery, row)),
        // The raw, full-precision `created_at` (§7a — a truncated cursor breaks the walk).
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ createdAt: last.delivery.createdAt, id: last.delivery.id }) : null,
      };
    });
  }

  async getDelivery(tenantId: string, actorUserId: string, clientId: string, endpointId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.authorise(tx, tenantId, actorUserId, clientId);
      await this.readEndpoint(tx, tenantId, clientId, endpointId);
      if (!UUID_RE.test(deliveryId)) throw missingDelivery(deliveryId);
      const rows = await tx
        .select({ delivery: webhookDeliveries, eventType: webhookEvents.eventType, subjectId: webhookEvents.subjectId, body: webhookEvents.body })
        .from(webhookDeliveries)
        .innerJoin(webhookEvents, and(eq(webhookEvents.tenantId, webhookDeliveries.tenantId), eq(webhookEvents.id, webhookDeliveries.eventId)))
        .where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.id, deliveryId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw missingDelivery(deliveryId);
      return { ...toDeliveryView(row.delivery, row), body: row.body };
    });
  }

  // ── the sender's entry points ──────────────────────────────────────────

  /** A tick for the worker (one per process tick, shared by every tenant). */
  newTick(onSend?: () => void): WebhookTick {
    return newWebhookTick(webhookConfigFromEnv(), onSend);
  }

  /** `WEBHOOK_MAX_PER_TICK` (the worker's discovery cap). */
  maxPerTick(): number {
    return webhookConfigFromEnv().maxPerTick;
  }

  /**
   * One tenant's sweep and claim; `done` settles when its sends have (the
   * worker starts every tenant's sends into the shared pool before awaiting
   * any, so one slow receiver never holds another tenant back — A3).
   */
  async sendDueWebhooks(tenantId: string, tick?: WebhookTick): Promise<WebhookTenantRun> {
    return this.sender.runTenant(tenantId, tick);
  }

  /** The suites' and scripts' form: the whole run, awaited. */
  async sendDueWebhooksNow(tenantId: string, tick?: WebhookTick): Promise<WebhookSendSummary> {
    return (await this.sender.runTenant(tenantId, tick)).done;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async authorise(tx: TenantTx, tenantId: string, actorUserId: string, clientId: string): Promise<void> {
    assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'clients.manage');
    if (!UUID_RE.test(clientId)) throw clientNotFound(clientId);
    if (!(await getClientsInTx(tx, tenantId, [clientId])).has(clientId)) throw clientNotFound(clientId);
  }

  /** The endpoint of THIS client (deleted ones included — their deliveries stay readable), 404 otherwise. */
  private async readEndpoint(tx: TenantTx, tenantId: string, clientId: string, endpointId: string): Promise<void> {
    if (!UUID_RE.test(endpointId)) throw webhookEndpointNotFound(endpointId);
    const rows = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.clientId, clientId), eq(webhookEndpoints.id, endpointId)))
      .limit(1);
    if (rows.length === 0) throw webhookEndpointNotFound(endpointId);
  }
}

