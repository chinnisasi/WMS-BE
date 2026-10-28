import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, webhookDeliveries, webhookEndpoints, webhookEvents, type WebhookEndpointRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7, uuidv7TimestampMs } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertClientTakesWorkInTx, clientDeparted, clientLabel, lockClientInTx, type LockedClientFacts } from '../clients/clients.facade';
import { webhookConfigFromEnv } from './webhook-config';
import { generateSigningSecret, openSigningKeys, sealSigningSecret, webhookSealKeyAvailable } from './webhook-secrets';
import { serialiseEnvelope } from './webhook-payloads';
import { WebhookSender } from './webhook.sender';
import { toDeliveryView, toEndpointView, type WebhookDeliveryView, type WebhookEndpointView } from './client-webhooks.views';
import {
  MAX_WEBHOOK_ENDPOINTS_PER_CLIENT,
  WEBHOOK_BULK_REDELIVER_MAX,
  WEBHOOK_BULK_REDELIVER_STATUSES,
  WEBHOOK_DELETED_EVENT,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  WEBHOOK_ENABLED_EVENT,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HELD_DECISIONS,
  WEBHOOK_MANUAL_SENDS_PER_MINUTE,
  WEBHOOK_MANUALLY_DISABLED_EVENT,
  WEBHOOK_PREVIOUS_SECRET_TTL_MS,
  WEBHOOK_RETENTION_DAYS,
  WEBHOOK_TEST_EVENT_TYPE,
  WebhookUrlError,
  isWebhookEventType,
  normaliseWebhookUrl,
  outcomeErrorCode,
  outcomeStatusCode,
  sortEventTypes,
  webhookUrlWithoutQuery,
  type WebhookBulkRedeliverStatus,
  type WebhookEventType,
  type WebhookHeldDecision,
} from './webhook-rules';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const URL_UNIQUE = 'webhook_endpoints_client_url_unique';

// ── commands and snapshots ───────────────────────────────────────────────

interface Actor {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
}

export interface CreateWebhookEndpointCommand extends Actor {
  readonly url: string;
  readonly description?: string | null;
  readonly eventTypes: readonly string[];
}

export interface UpdateWebhookEndpointCommand extends Actor {
  readonly endpointId: string;
  readonly url?: string;
  readonly description?: string | null;
  readonly eventTypes?: readonly string[];
  readonly status?: 'active' | 'disabled';
  readonly held?: WebhookHeldDecision;
}

export interface EndpointRefCommand extends Actor {
  readonly endpointId: string;
}

export interface RotateWebhookSecretCommand extends EndpointRefCommand {
  readonly revokePrevious?: boolean;
}

export interface RedeliverWebhookCommand extends EndpointRefCommand {
  readonly deliveryId: string;
}

export interface BulkRedeliverWebhooksCommand extends EndpointRefCommand {
  readonly since: string;
  readonly statuses?: readonly string[];
}

/** An endpoint mutation's answer. `signingSecret` is the raw secret ONLY on a fresh create or rotate — never stored. */
export interface WebhookEndpointMutationSnapshot {
  readonly endpoint: WebhookEndpointView;
  readonly signingSecret: string | null;
  /** The held backlog's fate on a re-enable (A5): how many were released or discarded. */
  readonly heldReleased?: number;
  readonly heldDiscarded?: number;
}

export interface WebhookTestSnapshot {
  readonly test: { readonly statusCode: number | null; readonly errorCode: string | null; readonly durationMs: number };
}

export interface WebhookRedeliverSnapshot {
  readonly delivery: WebhookDeliveryView;
}

export interface WebhookBulkRedeliverSnapshot {
  readonly redelivered: number;
  readonly remaining: number;
}

type AuditAction =
  | 'webhook_endpoint.created'
  | 'webhook_endpoint.updated'
  | 'webhook_endpoint.deleted'
  | 'webhook_endpoint.secret_rotated'
  | 'webhook_endpoint.secret_revoked'
  | 'webhook_endpoint.test_sent'
  | 'webhook_endpoint.redelivered'
  | 'webhook_endpoint.bulk_redelivered';

// ── refusals ─────────────────────────────────────────────────────────────

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid webhook endpoint', detail);
}

export function webhookEndpointNotFound(endpointId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Webhook endpoint not found', `No webhook endpoint ${endpointId} exists for this client.`);
}

function deliveryNotFound(deliveryId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Webhook delivery not found', `No delivery ${deliveryId} exists for this endpoint.`);
}

/** A2 — a missing delivery whose uuidv7 is older than the retention: purged, not unknown. */
export function missingDelivery(deliveryId: string, now = Date.now()): ProblemException {
  const minted = uuidv7TimestampMs(deliveryId);
  if (minted !== null && now - minted > WEBHOOK_RETENTION_DAYS * 86_400_000) return deliveryPurged(deliveryId);
  return deliveryNotFound(deliveryId);
}

function deliveryPurged(deliveryId: string): ProblemException {
  return new ProblemException(
    'delivery-purged',
    410,
    'Webhook delivery purged',
    `Delivery ${deliveryId} is older than ${WEBHOOK_RETENTION_DAYS} days and was purged — the audit trail keeps the record.`,
  );
}

function unavailable(detail: string): ProblemException {
  return new ProblemException('webhooks-unavailable', 409, 'Webhooks are unavailable on this server', detail);
}

function endpointDisabled(): ProblemException {
  return new ProblemException(
    'webhook-endpoint-disabled',
    409,
    'The webhook endpoint is not active',
    'Enable the endpoint before redelivering to it (a test send is allowed while it is disabled).',
  );
}

function rateLimited(retryAfterSeconds: number): ProblemException {
  return new ProblemException(
    'rate-limited',
    429,
    'Too many manual sends',
    `At most ${WEBHOOK_MANUAL_SENDS_PER_MINUTE} test sends and redeliveries a minute per endpoint. Try again in ${retryAfterSeconds} seconds.`,
    { retryAfterSeconds },
  );
}

/** Shape rules above the transaction (§1 tier 1): the URL, the event-type vocabulary, the description. */
function assertUrl(raw: string): string {
  try {
    return normaliseWebhookUrl(raw, webhookConfigFromEnv().denyHosts);
  } catch (err) {
    if (err instanceof WebhookUrlError) throw validation(`${err.message} (rule: ${err.rule})`);
    throw err;
  }
}

function assertEventTypes(raw: readonly string[]): WebhookEventType[] {
  if (raw.length === 0) throw validation(`eventTypes must name at least one of ${JSON.stringify(WEBHOOK_EVENT_TYPES)}.`);
  const unknown = raw.filter((type) => !isWebhookEventType(type));
  if (unknown.length > 0) throw validation(`eventTypes must be among ${JSON.stringify(WEBHOOK_EVENT_TYPES)} (got ${JSON.stringify(unknown)}).`);
  if (new Set(raw).size !== raw.length) throw validation('eventTypes must not repeat a type.');
  return sortEventTypes(raw as WebhookEventType[]);
}

/** Blank → null; otherwise trimmed and at most 200 characters. */
function normaliseDescription(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > WEBHOOK_DESCRIPTION_MAX_LENGTH) throw validation(`description must be at most ${WEBHOOK_DESCRIPTION_MAX_LENGTH} characters.`);
  return trimmed;
}

function assertUuid(name: string, value: string, notFound: () => ProblemException): void {
  if (!UUID_RE.test(value)) throw notFound();
  void name;
}

/**
 * Story 5-2a (decision 14 as amended by A2, A4, A5, A10, A17, A20) — the
 * webhook endpoint commands, staff-only and owner-only (`clients.manage`),
 * every one keyed and audited (target `webhook_endpoint`). The guard order is
 * the §1 skeleton: shape checks above the transaction → the hash →
 * `clients.manage` → replay → `lockClientInTx` (`FOR NO KEY UPDATE`, the
 * contacts lock) → replay again under the lock → the endpoint by (tenant,
 * client, id) — an unknown id and another client's id are the same 404 →
 * the guards → the write → outbox → audit → the key.
 *
 * Lock order: the client, then the endpoint (`FOR UPDATE`). The sender locks
 * only endpoints and nothing locks an endpoint before its client, so there is
 * no cycle.
 *
 * Fingerprints start `{arm, tenantId, clientId, …}` with the URL normalised
 * and `eventTypes` in the tuple's order.
 */
@Injectable()
export class ClientWebhooksCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(WebhookSender) private readonly sender: WebhookSender,
  ) {}

  async create(command: CreateWebhookEndpointCommand, idempotencyKey: string): Promise<WebhookEndpointMutationSnapshot> {
    const url = assertUrl(command.url);
    const eventTypes = assertEventTypes(command.eventTypes);
    const description = normaliseDescription(command.description) ?? null;
    const payloadHash = hashCommandPayload({
      arm: 'webhook-create',
      tenantId: command.tenantId,
      clientId: command.clientId,
      url,
      description,
      eventTypes,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookEndpointMutationSnapshot;
      assertNotSelf(client.locked);
      await assertClientTakesWorkInTx(tx, command.tenantId, client.locked.id);
      if (!webhookSealKeyAvailable()) {
        throw unavailable('WEBHOOK_SEAL_KEY is not configured on this server, so no signing secret can be created. Ask your administrator.');
      }
      const existing = await tx
        .select({ id: webhookEndpoints.id, url: webhookEndpoints.url })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.tenantId, command.tenantId), eq(webhookEndpoints.clientId, client.locked.id), ne(webhookEndpoints.status, 'deleted')));
      if (existing.length >= MAX_WEBHOOK_ENDPOINTS_PER_CLIENT) {
        throw new ProblemException(
          'webhook-endpoint-limit',
          409,
          'Too many webhook endpoints',
          `Client "${client.locked.code}" already has ${MAX_WEBHOOK_ENDPOINTS_PER_CLIENT} webhook endpoints — delete one before adding another.`,
        );
      }
      if (existing.some((row) => row.url === url)) throw duplicateUrl(url);
      const id = uuidv7();
      const { secret, hint } = generateSigningSecret();
      let row: WebhookEndpointRow;
      try {
        row = (
          await tx
            .insert(webhookEndpoints)
            .values({
              id,
              tenantId: command.tenantId,
              clientId: client.locked.id,
              url,
              description,
              eventTypes,
              status: 'active',
              secretSealed: sealSigningSecret(secret, command.tenantId, id),
              secretHint: hint,
              createdBy: command.actorUserId,
            })
            .returning()
        )[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, URL_UNIQUE)) throw duplicateUrl(url);
        throw err;
      }
      const stored: WebhookEndpointMutationSnapshot = { endpoint: toEndpointView(row), signingSecret: null };
      await this.audit(tx, command, 'webhook_endpoint.created', id, idempotencyKey, { url: webhookUrlWithoutQuery(url), eventTypes, description });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, stored);
      // The raw secret leaves exactly once — in this response, never in the stored snapshot (5-1a B6).
      return { ...stored, signingSecret: secret };
    });
  }

  async update(command: UpdateWebhookEndpointCommand, idempotencyKey: string): Promise<WebhookEndpointMutationSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    const url = command.url === undefined ? undefined : assertUrl(command.url);
    const eventTypes = command.eventTypes === undefined ? undefined : assertEventTypes(command.eventTypes);
    const description = normaliseDescription(command.description);
    if (command.status !== undefined && command.status !== 'active' && command.status !== 'disabled') {
      throw validation('status must be "active" or "disabled".');
    }
    if (command.held !== undefined) {
      if (!(WEBHOOK_HELD_DECISIONS as readonly string[]).includes(command.held)) throw validation(`held must be one of ${JSON.stringify(WEBHOOK_HELD_DECISIONS)}.`);
      if (command.status !== 'active') throw validation('held is decided only when enabling the endpoint (status: "active").');
    }
    const payloadHash = hashCommandPayload({
      arm: 'webhook-update',
      tenantId: command.tenantId,
      clientId: command.clientId,
      endpointId: command.endpointId,
      ...(url === undefined ? {} : { url }),
      ...(description === undefined ? {} : { description }),
      ...(eventTypes === undefined ? {} : { eventTypes }),
      ...(command.status === undefined ? {} : { status: command.status }),
      ...(command.held === undefined ? {} : { held: command.held }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookEndpointMutationSnapshot;
      const current = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);

      const nextUrl = url ?? current.url;
      const nextDescription = description === undefined ? current.description : description;
      const nextTypes = eventTypes ?? (current.eventTypes as WebhookEventType[]);
      const nextStatus = command.status ?? (current.status as 'active' | 'disabled');
      const enabling = current.status === 'disabled' && nextStatus === 'active';
      const disabling = current.status === 'active' && nextStatus === 'disabled';
      // failing / gone / client-departed → manual: a manual disable of an
      // auto-disabled endpoint (A10 — resolves the panel entry).
      const toManual = current.status === 'disabled' && command.status === 'disabled' && current.disabledReason !== 'manual';
      const unchanged =
        nextUrl === current.url &&
        nextDescription === current.description &&
        sameTypes(nextTypes, current.eventTypes) &&
        !enabling &&
        !disabling &&
        !toManual;
      if (unchanged) {
        // A declared no-op that stores the key (`clientWebhooks.update:unchanged`):
        // a status is not idempotent in value (the 21-10 rule), so a later
        // replay must answer THIS answer, not today's row.
        const snapshot: WebhookEndpointMutationSnapshot = { endpoint: toEndpointView(current), signingSecret: null };
        await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      if (nextUrl !== current.url) {
        const clash = await tx
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.tenantId, command.tenantId),
              eq(webhookEndpoints.clientId, client.locked.id),
              eq(webhookEndpoints.url, nextUrl),
              ne(webhookEndpoints.status, 'deleted'),
              ne(webhookEndpoints.id, current.id),
            ),
          )
          .limit(1);
        if (clash.length > 0) throw duplicateUrl(nextUrl);
      }

      let heldReleased: number | undefined;
      let heldDiscarded: number | undefined;
      const set: Record<string, unknown> = {
        url: nextUrl,
        description: nextDescription,
        eventTypes: nextTypes,
        updatedAt: sql`now()`,
      };
      // A4 — a new URL starts a clean failure record.
      if (nextUrl !== current.url) Object.assign(set, { consecutiveFailures: 0, failingSince: null });
      const episodeBefore = current.disabledEpisodeId;
      let event: { type: string; payload: Record<string, unknown> } | null = null;

      if (enabling) {
        if (client.locked.status === 'departed') throw clientDeparted(clientLabel(client.locked));
        const held = await this.countHeld(tx, command.tenantId, current.id);
        if (held > 0 && command.held === undefined) {
          throw new ProblemException(
            'held-decision-required',
            409,
            'Decide what happens to the held deliveries',
            `${held} deliveries were held while the endpoint was failing — re-enable with held: "release" to send them, or "discard" to drop them.`,
            { heldCount: held },
          );
        }
        Object.assign(set, {
          status: 'active',
          disabledReason: null,
          disabledAt: null,
          disabledEpisodeId: null,
          consecutiveFailures: 0,
          failingSince: null,
        });
        if (held > 0 && command.held === 'release') {
          heldReleased = (
            (await tx.execute(sql`
              update webhook_deliveries
                 set status = 'pending', attempts = 0, next_attempt_at = now(), pending_since = now(), updated_at = now()
               where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${current.id}::uuid and status = 'held'
              returning id
            `)) as unknown as unknown[]
          ).length;
        } else if (held > 0) {
          heldDiscarded = (
            (await tx.execute(sql`
              update webhook_deliveries set status = 'failed', last_error_code = 'discarded', updated_at = now()
               where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${current.id}::uuid and status = 'held'
              returning id
            `)) as unknown as unknown[]
          ).length;
        }
        event = { type: WEBHOOK_ENABLED_EVENT, payload: { endpointId: current.id, clientId: current.clientId, episodeId: episodeBefore } };
      } else if (disabling || toManual) {
        Object.assign(set, { status: 'disabled', disabledReason: 'manual', disabledAt: sql`now()`, disabledEpisodeId: null });
        // A5 — a manual disable does not hold: pending and held rows fail.
        await tx.execute(sql`
          update webhook_deliveries set status = 'failed', last_error_code = 'endpoint-disabled', updated_at = now()
           where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${current.id}::uuid and status in ('pending', 'held')
        `);
        if (toManual) {
          event = { type: WEBHOOK_MANUALLY_DISABLED_EVENT, payload: { endpointId: current.id, clientId: current.clientId, episodeId: episodeBefore } };
        }
      }

      // A4 — narrowing the types: the dropped types' pending and held rows fail `unsubscribed`.
      const dropped = (current.eventTypes as string[]).filter((type) => !nextTypes.includes(type as WebhookEventType));
      if (dropped.length > 0) {
        await tx.execute(sql`
          update webhook_deliveries d set status = 'failed', last_error_code = 'unsubscribed', updated_at = now()
            from webhook_events e
           where d.tenant_id = ${command.tenantId}::uuid and d.endpoint_id = ${current.id}::uuid and d.status in ('pending', 'held')
             and e.tenant_id = d.tenant_id and e.id = d.event_id and e.event_type = any(${sql.param(dropped)}::text[])
        `);
      }

      let updated: WebhookEndpointRow;
      try {
        updated = (
          await tx
            .update(webhookEndpoints)
            .set(set)
            .where(and(eq(webhookEndpoints.tenantId, command.tenantId), eq(webhookEndpoints.id, current.id)))
            .returning()
        )[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, URL_UNIQUE)) throw duplicateUrl(nextUrl);
        throw err;
      }
      if (event !== null) {
        await this.outbox.append(tx, { messageId: uuidv7(), tenantId: command.tenantId, type: event.type, occurredAt: nowIso(), payload: event.payload });
      }
      const changes: Record<string, unknown> = {};
      if (nextUrl !== current.url) changes.url = { before: webhookUrlWithoutQuery(current.url), after: webhookUrlWithoutQuery(nextUrl) };
      if (nextDescription !== current.description) changes.description = { before: current.description, after: nextDescription };
      if (!sameTypes(nextTypes, current.eventTypes)) changes.eventTypes = { before: current.eventTypes, after: nextTypes };
      if (updated.status !== current.status || updated.disabledReason !== current.disabledReason) {
        changes.status = { before: current.status, after: updated.status };
        changes.disabledReason = { before: current.disabledReason, after: updated.disabledReason };
      }
      if (heldReleased !== undefined) changes.heldReleased = heldReleased;
      if (heldDiscarded !== undefined) changes.heldDiscarded = heldDiscarded;
      const snapshot: WebhookEndpointMutationSnapshot = {
        endpoint: toEndpointView(updated),
        signingSecret: null,
        ...(heldReleased === undefined ? {} : { heldReleased }),
        ...(heldDiscarded === undefined ? {} : { heldDiscarded }),
      };
      await this.audit(tx, command, 'webhook_endpoint.updated', current.id, idempotencyKey, changes);
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** A4 — a SOFT delete: always succeeds on a live endpoint; its pending and held rows fail `endpoint-deleted`. */
  async remove(command: EndpointRefCommand, idempotencyKey: string): Promise<WebhookEndpointMutationSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    const payloadHash = hashCommandPayload({ arm: 'webhook-delete', tenantId: command.tenantId, clientId: command.clientId, endpointId: command.endpointId });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookEndpointMutationSnapshot;
      const current = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);
      await tx.execute(sql`
        update webhook_deliveries set status = 'failed', last_error_code = 'endpoint-deleted', updated_at = now()
         where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${current.id}::uuid and status in ('pending', 'held')
      `);
      const updated = (
        await tx
          .update(webhookEndpoints)
          .set({
            status: 'deleted',
            deletedAt: sql`now()`,
            disabledReason: null,
            disabledAt: null,
            disabledEpisodeId: null,
            previousSecretSealed: null,
            previousSecretExpiresAt: null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(webhookEndpoints.tenantId, command.tenantId), eq(webhookEndpoints.id, current.id)))
          .returning()
      )[0]!;
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: WEBHOOK_DELETED_EVENT,
        occurredAt: nowIso(),
        payload: { endpointId: current.id, clientId: current.clientId, episodeId: current.disabledEpisodeId },
      });
      const snapshot: WebhookEndpointMutationSnapshot = { endpoint: toEndpointView(updated), signingSecret: null };
      await this.audit(tx, command, 'webhook_endpoint.deleted', current.id, idempotencyKey, { url: webhookUrlWithoutQuery(current.url) });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * A17 — a new secret. The old one keeps signing for 24 h (`revokePrevious:
   * true` ends it now, audited `secret_revoked`); a second rotation inside
   * the window drops the oldest. The raw secret is answered once.
   */
  async rotateSecret(command: RotateWebhookSecretCommand, idempotencyKey: string): Promise<WebhookEndpointMutationSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    const revokePrevious = command.revokePrevious === true;
    const payloadHash = hashCommandPayload({
      arm: 'webhook-rotate',
      tenantId: command.tenantId,
      clientId: command.clientId,
      endpointId: command.endpointId,
      revokePrevious,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookEndpointMutationSnapshot;
      const current = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);
      if (!webhookSealKeyAvailable()) {
        throw unavailable('WEBHOOK_SEAL_KEY is not configured on this server, so no signing secret can be created. Ask your administrator.');
      }
      const { secret, hint } = generateSigningSecret();
      const expiresAt = new Date(Date.now() + WEBHOOK_PREVIOUS_SECRET_TTL_MS).toISOString();
      const updated = (
        await tx
          .update(webhookEndpoints)
          .set({
            secretSealed: sealSigningSecret(secret, command.tenantId, current.id),
            secretHint: hint,
            previousSecretSealed: revokePrevious ? null : current.secretSealed,
            previousSecretExpiresAt: revokePrevious ? null : expiresAt,
            updatedAt: sql`now()`,
          })
          .where(and(eq(webhookEndpoints.tenantId, command.tenantId), eq(webhookEndpoints.id, current.id)))
          .returning()
      )[0]!;
      const stored: WebhookEndpointMutationSnapshot = { endpoint: toEndpointView(updated), signingSecret: null };
      await this.audit(
        tx,
        command,
        revokePrevious ? 'webhook_endpoint.secret_revoked' : 'webhook_endpoint.secret_rotated',
        current.id,
        idempotencyKey,
        { secretHint: { before: current.secretHint, after: hint }, previousSecretExpiresAt: revokePrevious ? null : expiresAt },
      );
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, stored);
      return { ...stored, signingSecret: secret };
    });
  }

  /**
   * A4 — the synchronous test send. Allowed on a disabled endpoint (staff
   * check a fix before enabling); never on a deleted one. Transaction A
   * (authority, replay, the guards, the rate limit — committed) → one signed
   * POST of a `webhook.test` envelope through the guarded transport, outside
   * any transaction → transaction B (replay again, audit, key). It stores
   * no event or delivery and never touches the counters.
   */
  async test(command: EndpointRefCommand, idempotencyKey: string): Promise<WebhookTestSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    const payloadHash = hashCommandPayload({ arm: 'webhook-test', tenantId: command.tenantId, clientId: command.clientId, endpointId: command.endpointId });
    const config = webhookConfigFromEnv();
    const prepared = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return { replayed: client.replayed as WebhookTestSnapshot } as const;
      const endpoint = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);
      if (config.gateway !== 'https') {
        throw unavailable('Webhook sending is turned off on this server (WEBHOOK_GATEWAY=off), so a test cannot be sent. Ask your administrator.');
      }
      await this.hitRateLimit(tx, command.tenantId, endpoint.id);
      let keys: Buffer[] | null = null;
      try {
        keys = openSigningKeys(
          {
            tenantId: command.tenantId,
            endpointId: endpoint.id,
            secretSealed: endpoint.secretSealed,
            previousSecretSealed: endpoint.previousSecretSealed,
            previousSecretExpiresAt: endpoint.previousSecretExpiresAt,
          },
          Date.now(),
        );
      } catch {
        keys = null;
      }
      return { endpoint, clientCode: client.locked.code, keys } as const;
    });
    if ('replayed' in prepared) return prepared.replayed;

    let test: WebhookTestSnapshot['test'];
    if (prepared.keys === null) {
      test = { statusCode: null, errorCode: 'secret-unavailable', durationMs: 0 };
    } else {
      const id = uuidv7();
      const at = new Date().toISOString();
      const body = serialiseEnvelope(
        { id, type: WEBHOOK_TEST_EVENT_TYPE, schemaVersion: 1, occurredAt: at, createdAt: at, clientCode: prepared.clientCode },
        { endpointId: prepared.endpoint.id },
      );
      const outcome = await this.sender.sendTest(prepared.endpoint.url, prepared.keys, body, id, config);
      test = { statusCode: outcomeStatusCode(outcome), errorCode: outcomeErrorCode(outcome), durationMs: Math.max(0, Math.round(outcome.durationMs)) };
    }

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as WebhookTestSnapshot;
      const snapshot: WebhookTestSnapshot = { test };
      await this.audit(tx, command, 'webhook_endpoint.test_sent', prepared.endpoint.id, idempotencyKey, {
        statusCode: test.statusCode,
        errorCode: test.errorCode,
      });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** A final delivery back to `pending`: the same bytes, a fresh timestamp and signature, a fresh 72-hour clock. */
  async redeliver(command: RedeliverWebhookCommand, idempotencyKey: string): Promise<WebhookRedeliverSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    assertUuid('deliveryId', command.deliveryId, () => deliveryNotFound(command.deliveryId));
    const payloadHash = hashCommandPayload({
      arm: 'webhook-redeliver',
      tenantId: command.tenantId,
      clientId: command.clientId,
      endpointId: command.endpointId,
      deliveryId: command.deliveryId,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookRedeliverSnapshot;
      const endpoint = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);
      const rows = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.tenantId, command.tenantId),
            eq(webhookDeliveries.endpointId, endpoint.id),
            eq(webhookDeliveries.id, command.deliveryId),
          ),
        )
        .limit(1)
        .for('update');
      const delivery = rows[0];
      if (delivery === undefined) throw missingDelivery(command.deliveryId);
      if (endpoint.status !== 'active') throw endpointDisabled();
      if (delivery.status !== 'failed' && delivery.status !== 'succeeded') {
        throw new ProblemException(
          'delivery-in-progress',
          409,
          'The delivery is still in progress',
          `Delivery ${delivery.id} is ${delivery.status} — only a failed or succeeded delivery can be redelivered.`,
        );
      }
      await this.hitRateLimit(tx, command.tenantId, endpoint.id);
      const updated = (
        await tx
          .update(webhookDeliveries)
          .set({
            status: 'pending',
            attempts: 0,
            nextAttemptAt: sql`now()`,
            pendingSince: sql`now()`,
            succeededAt: null,
            claimedAt: null,
            redeliveryCount: sql`${webhookDeliveries.redeliveryCount} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(webhookDeliveries.tenantId, command.tenantId), eq(webhookDeliveries.id, delivery.id)))
          .returning()
      )[0]!;
      const event = (
        await tx
          .select({ eventType: webhookEvents.eventType, subjectId: webhookEvents.subjectId })
          .from(webhookEvents)
          .where(and(eq(webhookEvents.tenantId, command.tenantId), eq(webhookEvents.id, delivery.eventId)))
          .limit(1)
      )[0];
      // Code review C11 — never invent the facts: an event gone with its
      // delivery still present is purged (the bytes cannot be resent).
      if (event === undefined) throw deliveryPurged(command.deliveryId);
      const snapshot: WebhookRedeliverSnapshot = { delivery: toDeliveryView(updated, event) };
      await this.audit(tx, command, 'webhook_endpoint.redelivered', endpoint.id, idempotencyKey, {
        deliveryId: delivery.id,
        status: { before: delivery.status, after: 'pending' },
      });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** A2 — every failed (or only the expired) delivery created since `since`: at most 1000, oldest first. */
  async bulkRedeliver(command: BulkRedeliverWebhooksCommand, idempotencyKey: string): Promise<WebhookBulkRedeliverSnapshot> {
    assertUuid('endpointId', command.endpointId, () => webhookEndpointNotFound(command.endpointId));
    const sinceMs = Date.parse(command.since);
    if (Number.isNaN(sinceMs)) throw validation('since must be an ISO-8601 instant with a zone, such as 2026-10-20T00:00:00Z.');
    const since = new Date(sinceMs).toISOString();
    const statuses = [...new Set(command.statuses ?? WEBHOOK_BULK_REDELIVER_STATUSES)];
    const bad = statuses.filter((status) => !(WEBHOOK_BULK_REDELIVER_STATUSES as readonly string[]).includes(status));
    if (bad.length > 0 || statuses.length === 0) throw validation(`statuses must be among ${JSON.stringify(WEBHOOK_BULK_REDELIVER_STATUSES)}.`);
    const ordered = WEBHOOK_BULK_REDELIVER_STATUSES.filter((status) => statuses.includes(status)) as WebhookBulkRedeliverStatus[];
    const payloadHash = hashCommandPayload({
      arm: 'webhook-bulk-redeliver',
      tenantId: command.tenantId,
      clientId: command.clientId,
      endpointId: command.endpointId,
      since,
      statuses: ordered,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const client = await this.open(tx, command, idempotencyKey, payloadHash);
      if ('replayed' in client) return client.replayed as WebhookBulkRedeliverSnapshot;
      const endpoint = await this.lockEndpoint(tx, command.tenantId, client.locked.id, command.endpointId);
      if (endpoint.status !== 'active') throw endpointDisabled();
      await this.hitRateLimit(tx, command.tenantId, endpoint.id);
      // 'failed' covers every failure the RECEIVER side can fix — code review
      // C4: never a row whose type the endpoint no longer subscribes to, one
      // staff discarded, or a departed client's (each would fail again or
      // resend what staff chose to drop); 'expired' alone narrows to the expired ones.
      const match = ordered.includes('failed')
        ? sql`coalesce(last_error_code, '') not in ('unsubscribed', 'discarded', 'client-departed', 'endpoint-deleted')`
        : sql`last_error_code = 'expired'`;
      const reset = (await tx.execute(sql`
        update webhook_deliveries
           set status = 'pending', attempts = 0, next_attempt_at = now(), pending_since = now(),
               redelivery_count = redelivery_count + 1, updated_at = now()
         where id in (
           select id from webhook_deliveries
            where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${endpoint.id}::uuid and status = 'failed'
              and created_at >= ${since}::timestamptz and ${match}
            order by created_at, id
            limit ${WEBHOOK_BULK_REDELIVER_MAX}
            for update
         )
        returning id
      `)) as unknown as { id: string }[];
      const remainingRows = (await tx.execute(sql`
        select count(*)::int as "n" from webhook_deliveries
         where tenant_id = ${command.tenantId}::uuid and endpoint_id = ${endpoint.id}::uuid and status = 'failed'
           and created_at >= ${since}::timestamptz and ${match}
      `)) as unknown as { n: number }[];
      const snapshot: WebhookBulkRedeliverSnapshot = { redelivered: reset.length, remaining: Number(remainingRows[0]?.n ?? 0) };
      await this.audit(tx, command, 'webhook_endpoint.bulk_redelivered', endpoint.id, idempotencyKey, {
        since,
        statuses: ordered,
        count: reset.length,
      });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── the skeleton's shared steps ────────────────────────────────────────

  /** Authority → replay → the client lock (404) → replay again under the lock. */
  private async open(
    tx: TenantTx,
    command: Actor,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ replayed: unknown } | { locked: LockedClientFacts }> {
    assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'clients.manage');
    const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
    if (replayed !== null) return { replayed };
    if (!UUID_RE.test(command.clientId)) {
      throw new ProblemException('not-found', 404, 'Client not found', `No client ${command.clientId} exists in this tenant.`);
    }
    const locked = await lockClientInTx(tx, command.tenantId, command.clientId);
    const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
    if (replayedUnderLock !== null) return { replayed: replayedUnderLock };
    return { locked };
  }

  /** The endpoint of THIS client, `FOR UPDATE` — 404 when absent, another client's, or deleted. Lock only (§1). */
  private async lockEndpoint(tx: TenantTx, tenantId: string, clientId: string, endpointId: string): Promise<WebhookEndpointRow> {
    const rows = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.tenantId, tenantId),
          eq(webhookEndpoints.clientId, clientId),
          eq(webhookEndpoints.id, endpointId),
          ne(webhookEndpoints.status, 'deleted'),
        ),
      )
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw webhookEndpointNotFound(endpointId);
    return row;
  }

  private async countHeld(tx: TenantTx, tenantId: string, endpointId: string): Promise<number> {
    const rows = (await tx.execute(sql`
      select count(*)::int as "n" from webhook_deliveries
       where tenant_id = ${tenantId}::uuid and endpoint_id = ${endpointId}::uuid and status = 'held'
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * A20 — the manual-send limiter: a fixed one-minute window on the endpoint
   * row (locked by the caller). Past the limit → 429 `rate-limited`; the
   * refusal rolls the bump back, so the count stays at the limit until the
   * window turns.
   */
  private async hitRateLimit(tx: TenantTx, tenantId: string, endpointId: string): Promise<void> {
    const rows = (await tx.execute(sql`
      update webhook_endpoints
         set rate_window_count = case when rate_window_start = date_trunc('minute', now()) then rate_window_count + 1 else 1 end,
             rate_window_start = date_trunc('minute', now())
       where tenant_id = ${tenantId}::uuid and id = ${endpointId}::uuid
      returning rate_window_count as "count",
        greatest(1, ceil(extract(epoch from (date_trunc('minute', now()) + interval '1 minute' - now()))))::int as "retryAfter"
    `)) as unknown as { count: number; retryAfter: number }[];
    const row = rows[0];
    if (row !== undefined && Number(row.count) > WEBHOOK_MANUAL_SENDS_PER_MINUTE) throw rateLimited(Number(row.retryAfter));
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<unknown> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot;
  }

  private async audit(
    tx: TenantTx,
    command: Actor,
    action: AuditAction,
    endpointId: string,
    reference: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      reference,
      changes,
      occurredAt: nowIso(),
    });
  }

  private async writeKey(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string, snapshot: unknown): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key: idempotencyKey, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}

function assertNotSelf(client: LockedClientFacts): void {
  if (client.systemOwned) throw validation("The warehouse's own client cannot have webhooks.");
}

function duplicateUrl(url: string): ProblemException {
  return new ProblemException(
    'duplicate-webhook-url',
    409,
    'Duplicate webhook URL',
    `This client already has an endpoint for ${webhookUrlWithoutQuery(url)} — edit it instead of adding another.`,
  );
}

function sameTypes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

