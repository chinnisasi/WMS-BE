import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, webhookDeliveries, webhookEndpoints, webhookEvents } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { quarantinedMessagesInTx } from '../../shared/events/outbox';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { departedClientIdsInTx } from '../clients/clients.facade';
import { extraDenyList, webhookConfigFromEnv, type WebhookConfig } from './webhook-config';
import { guardedTransport, type WebhookTransport } from './webhook-http';
import { openSigningKeys } from './webhook-secrets';
import { webhookHeaders } from './webhook-signature';
import { WebhookEnqueue, trimHeldInTx } from './webhook.enqueue';
import {
  WEBHOOK_CONFIG_FAULT_RETRY_MS,
  WEBHOOK_DISABLED_EVENT,
  WEBHOOK_HELD_MAX_AGE_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT,
  WEBHOOK_PENDING_EXPIRY_MS,
  WEBHOOK_PURGE_BATCH,
  WEBHOOK_RECONCILE_WINDOW_MS,
  WEBHOOK_RETENTION_DAYS,
  WEBHOOK_SOURCE_EVENT_TYPES,
  WEBHOOK_STALE_MS,
  WEBHOOK_TICK_BUDGET_MS,
  classifyOutcome,
  outcomeErrorCode,
  outcomeStatusCode,
  shouldAutoDisable,
  webhookHostOf,
  webhookNextWaitMs,
  type WebhookDisabledReason,
  type WebhookSendOutcome,
} from './webhook-rules';

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000}::double precision)`;

/** A counting semaphore — the per-process send concurrency (A3). */
export class SendPool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * One worker tick's shared state (A3): the claim budget across every tenant,
 * the send pool (one per process tick), the 60-second budget after which no
 * new send starts, and the beat the worker's heartbeat takes per send.
 */
export interface WebhookTick {
  readonly deadline: number;
  readonly pool: SendPool;
  remaining: number;
  readonly onSend?: (() => void) | undefined;
}

export function newWebhookTick(config: Pick<WebhookConfig, 'maxPerTick' | 'sendConcurrency'>, onSend?: () => void, now = Date.now()): WebhookTick {
  return { deadline: now + WEBHOOK_TICK_BUDGET_MS, pool: new SendPool(config.sendConcurrency), remaining: config.maxPerTick, onSend };
}

/** What one tenant's sweep did. */
export interface WebhookSweepSummary {
  readonly stale: number;
  readonly expired: number;
  readonly heldExpired: number;
  readonly heldOverflow: number;
  readonly purgedDeliveries: number;
  readonly purgedEvents: number;
  readonly purgedEndpoints: number;
  readonly departedEndpoints: number;
  readonly reconciled: number;
  readonly autoDisabled: number;
}

/** What one tenant's sends did. */
export interface WebhookSendSummary extends WebhookSweepSummary {
  readonly claimed: number;
  readonly attempted: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  /** Claimed rows not started before the tick budget ran out — back to `pending`, no attempt spent. */
  readonly released: number;
  /** Rows the A4 re-check at claim moved off `pending` (failed or held). */
  readonly settledAtClaim: number;
  /** Config-fault codes met — logged once per TICK by the worker. */
  readonly configCodes: readonly string[];
}

/** One tenant's run: the claim phase is done; `done` settles when its sends have. */
export interface WebhookTenantRun {
  readonly claimed: number;
  readonly done: Promise<WebhookSendSummary>;
}

interface ClaimedDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly attempts: number;
  readonly claimedAt: string;
}

type OutcomeKind = 'succeeded' | 'retried' | 'failed' | 'config' | 'lost';

const EMPTY_SWEEP: WebhookSweepSummary = {
  stale: 0,
  expired: 0,
  heldExpired: 0,
  heldOverflow: 0,
  purgedDeliveries: 0,
  purgedEvents: 0,
  purgedEndpoints: 0,
  departedEndpoints: 0,
  reconciled: 0,
  autoDisabled: 0,
};

/**
 * Story 5-2a — the webhook SENDER, behind `ClientWebhooksFacade.sendDueWebhooks`
 * (driven per tenant by the jobs shell's `WebhookSenderWorker`; the 9-2b
 * push / 5-1a mail sender pattern). Per tenant:
 *
 *  1. **The sweep** (one tenant transaction): `sending` rows past five
 *     minutes return to `pending` (attempt counted `stale`, never a failure);
 *     expired previous secrets are dropped; `pending` rows past 72 h of
 *     `pending_since` fail `expired` (a FINAL failure, counted); held rows
 *     past 30 days fail `held-expired` and past 10,000 per endpoint
 *     `held-overflow`; final rows, empty events and soft-deleted endpoints
 *     past 30 days are purged; endpoints of a departed client are disabled
 *     `client-departed`; and quarantined `grn.recorded` / `order.dispatched`
 *     outbox rows younger than 72 h are reconciled through the enqueue (A1).
 *     The sweep runs even with `WEBHOOK_GATEWAY=off`.
 *  2. **The claim** (`https` only): due `pending` rows, at most two
 *     `sending` per endpoint across ticks and processes, interleaved
 *     round-robin, `FOR UPDATE SKIP LOCKED`. Each is re-checked against its
 *     endpoint and client (A4) — deleted, disabled (held when `failing`),
 *     unsubscribed, departed — and the rest become `sending` with a claim
 *     stamp. The claim COMMITS before any network call.
 *  3. **The sends**, in the tick's shared pool (8 per process): each re-reads
 *     the row (still `sending` under its stamp) and the endpoint's URL and
 *     secrets, signs with a fresh timestamp and POSTs through the guarded
 *     transport. Past the 60-second budget no send starts; the rest are
 *     released, no attempt spent.
 *  4. **Outcomes** (the A18 fate table), written only where the row is still
 *     `sending` under its stamp — safe in two processes — with the
 *     endpoint's counters moved atomically and the auto-disable decided
 *     under `FOR UPDATE` on the endpoint (A12).
 *
 * Logs carry tenant, endpoint and delivery ids, the URL HOST and the code —
 * never a query string, a header, a body or a secret.
 */
@Injectable()
export class WebhookSender {
  private readonly logger = new Logger('WebhookSender');
  /** The transport — a plain field the suites replace with a fake; null = the guarded HTTPS transport from the env. */
  transport: WebhookTransport | null = null;
  /** Jitter source (A2) — a plain field the suites pin. */
  random: () => number = Math.random;
  /**
   * Code review C10 — the slow sweep arms (held caps, purge, departure, the
   * quarantine reconcile) run at most this often per tenant per process; the
   * fast ones (stale, expiry) every tick. A plain field the suites set to 0.
   */
  slowSweepEveryMs = 60_000;
  private readonly lastSlowSweep = new Map<string, number>();
  /** Code review C22 — quarantined outbox rows already found unbuildable: never rebuilt (and logged) every tick. */
  private readonly unbuildable = new Set<string>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(WebhookEnqueue) private readonly enqueue: WebhookEnqueue,
  ) {}

  /** The transport in force for `config` (the suites' fake, else the guarded one). */
  transportFor(config: WebhookConfig): WebhookTransport {
    return (
      this.transport ??
      guardedTransport({ timeoutMs: config.httpTimeoutMs, denyHosts: config.denyHosts, extraDeny: extraDenyList(config) })
    );
  }

  async runTenant(tenantId: string, tick?: WebhookTick): Promise<WebhookTenantRun> {
    const config = webhookConfigFromEnv();
    const ownTick = tick ?? newWebhookTick(config);
    const sweep = await this.sweep(tenantId);
    // Code review C24 — past the tick budget no send starts, so claiming now
    // would only claim and release: a late tenant waits for the next tick.
    if (config.gateway !== 'https' || ownTick.remaining <= 0 || Date.now() >= ownTick.deadline) {
      return { claimed: 0, done: Promise.resolve({ ...sweep, ...zeroSends() }) };
    }
    const claim = await this.claim(tenantId, ownTick.remaining);
    ownTick.remaining = Math.max(0, ownTick.remaining - claim.claimed.length);
    const done = this.sendClaimed(tenantId, claim.claimed, ownTick, config).then((sends) => ({
      ...sweep,
      ...sends,
      claimed: claim.claimed.length,
      settledAtClaim: claim.settled,
    }));
    return { claimed: claim.claimed.length, done };
  }

  // ── 1. the sweep ───────────────────────────────────────────────────────

  async sweep(tenantId: string): Promise<WebhookSweepSummary> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // A stale return counts the attempt (A3) and restarts the 72 h clock
      // (A2); code review C1 — once the attempts are spent the row is FINAL
      // (`failed stale`, never counted toward auto-disable), so a delivery
      // that kills the worker every time cannot loop forever.
      const stale = (await tx.execute(sql`
        update webhook_deliveries
           set status = case when attempts + 1 >= ${WEBHOOK_MAX_ATTEMPTS} then 'failed' else 'pending' end,
               claimed_at = null, attempts = attempts + 1, last_error_code = 'stale',
               last_attempt_at = now(), next_attempt_at = now(), pending_since = now(), updated_at = now()
         where tenant_id = ${tenantId}::uuid and status = 'sending' and claimed_at < now() - ${secs(WEBHOOK_STALE_MS)}
        returning id
      `)) as unknown as { id: string }[];

      await tx.execute(sql`
        update webhook_endpoints
           set previous_secret_sealed = null, previous_secret_expires_at = null, updated_at = now()
         where tenant_id = ${tenantId}::uuid and previous_secret_expires_at <= now()
      `);

      const expired = (await tx.execute(sql`
        with due as (
          select id, attempts, last_error_code from webhook_deliveries
           where tenant_id = ${tenantId}::uuid and status = 'pending' and pending_since < now() - ${secs(WEBHOOK_PENDING_EXPIRY_MS)}
           for update
        )
        update webhook_deliveries d
           set status = 'failed', last_error_code = 'expired', updated_at = now()
          from due
         where d.id = due.id
        returning d.endpoint_id as "endpointId", due.attempts as "attempts", due.last_error_code as "lastErrorCode"
      `)) as unknown as { endpointId: string; attempts: number; lastErrorCode: string | null }[];
      let autoDisabled = 0;
      const expiredBy = new Map<string, number>();
      // Code review C2 — an expiry counts toward auto-disable only when the
      // RECEIVER was tried and failed: never a row nothing was sent for
      // (gateway off, a backlog) nor one held back by our own config fault
      // (`secret-unavailable`, A17: never counted).
      for (const row of expired) {
        if (Number(row.attempts) === 0 || row.lastErrorCode === 'secret-unavailable') continue;
        expiredBy.set(row.endpointId, (expiredBy.get(row.endpointId) ?? 0) + 1);
      }
      for (const [endpointId, count] of [...expiredBy.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (await this.countFinalFailuresInTx(tx, tenantId, endpointId, count)) autoDisabled += 1;
      }

      const nowMs = Date.now();
      const slow = nowMs - (this.lastSlowSweep.get(tenantId) ?? 0) >= this.slowSweepEveryMs;
      if (!slow) {
        return { ...EMPTY_SWEEP, stale: stale.length, expired: expired.length, autoDisabled };
      }
      this.lastSlowSweep.set(tenantId, nowMs);

      const heldExpired = (await tx.execute(sql`
        update webhook_deliveries
           set status = 'failed', last_error_code = 'held-expired', updated_at = now()
         where tenant_id = ${tenantId}::uuid and status = 'held' and created_at < now() - make_interval(days => ${WEBHOOK_HELD_MAX_AGE_DAYS})
        returning id
      `)) as unknown as { id: string }[];
      const heldEndpoints = (await tx.execute(sql`
        select distinct endpoint_id::text as "endpointId" from webhook_deliveries
         where tenant_id = ${tenantId}::uuid and status = 'held'
      `)) as unknown as { endpointId: string }[];
      const heldOverflow = await trimHeldInTx(tx, tenantId, heldEndpoints.map((row) => row.endpointId));

      const purgedDeliveries = (await tx.execute(sql`
        delete from webhook_deliveries
         where id in (
           select id from webhook_deliveries
            where tenant_id = ${tenantId}::uuid and status in ('succeeded', 'failed')
              and coalesce(succeeded_at, last_attempt_at, created_at) < now() - make_interval(days => ${WEBHOOK_RETENTION_DAYS})
            limit ${WEBHOOK_PURGE_BATCH}
         )
        returning id
      `)) as unknown as { id: string }[];
      // A soft-deleted endpoint past retention: its (final) deliveries, then the row.
      const purgedEndpointRows = (await tx.execute(sql`
        select id::text as "id" from webhook_endpoints
         where tenant_id = ${tenantId}::uuid and status = 'deleted' and deleted_at < now() - make_interval(days => ${WEBHOOK_RETENTION_DAYS})
         limit ${WEBHOOK_PURGE_BATCH}
      `)) as unknown as { id: string }[];
      let purgedEndpoints = 0;
      if (purgedEndpointRows.length > 0) {
        const ids = purgedEndpointRows.map((row) => row.id);
        await tx.execute(sql`
          delete from webhook_deliveries
           where tenant_id = ${tenantId}::uuid and endpoint_id = any(${sql.param(ids)}::uuid[]) and status in ('succeeded', 'failed', 'held', 'pending')
        `);
        const removed = (await tx.execute(sql`
          delete from webhook_endpoints
           where tenant_id = ${tenantId}::uuid and status = 'deleted' and id = any(${sql.param(ids)}::uuid[])
             and not exists (select 1 from webhook_deliveries d where d.tenant_id = webhook_endpoints.tenant_id and d.endpoint_id = webhook_endpoints.id)
          returning id
        `)) as unknown as { id: string }[];
        purgedEndpoints = removed.length;
      }
      const purgedEvents = (await tx.execute(sql`
        delete from webhook_events
         where id in (
           select e.id from webhook_events e
            where e.tenant_id = ${tenantId}::uuid and e.created_at < now() - make_interval(days => ${WEBHOOK_RETENTION_DAYS})
              and not exists (select 1 from webhook_deliveries d where d.tenant_id = e.tenant_id and d.event_id = e.id)
            limit ${WEBHOOK_PURGE_BATCH}
         )
        returning id
      `)) as unknown as { id: string }[];

      // Client departure (A4): the clients module emits no event on a status
      // change, so the webhooks module notices lazily, here and at claim.
      let departedEndpoints = 0;
      const departed = await departedClientIdsInTx(tx, tenantId);
      if (departed.size > 0) {
        departedEndpoints = await this.disableDepartedInTx(tx, tenantId, [...departed]);
      }

      // The quarantine reconcile (A1): an earlier handler that threw five
      // times quarantined the row, so the webhook handler never ran for it.
      let reconciled = 0;
      const live = await tx
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.tenantId, tenantId),
            sql`(${webhookEndpoints.status} = 'active' or (${webhookEndpoints.status} = 'disabled' and ${webhookEndpoints.disabledReason} = 'failing'))`,
          ),
        )
        .limit(1);
      if (live.length > 0) {
        const since = new Date(Date.now() - WEBHOOK_RECONCILE_WINDOW_MS).toISOString();
        const rows = await quarantinedMessagesInTx(tx, tenantId, WEBHOOK_SOURCE_EVENT_TYPES, since);
        for (const row of rows) {
          if (this.unbuildable.has(row.id)) continue;
          try {
            // A savepoint per row: one bad row cannot abort the sweep.
            const outcome = await tx.transaction((sp) =>
              this.enqueue.enqueueFromSourceInTx(sp, tenantId, { type: row.type, eventId: row.id, occurredAt: row.occurredAt, payload: row.payload }),
            );
            if (outcome.kind === 'malformed') {
              if (this.unbuildable.size > 10_000) this.unbuildable.clear();
              this.unbuildable.add(row.id);
            }
            if (outcome.kind === 'enqueued') {
              reconciled += 1;
              this.logger.warn(`webhook reconcile (tenant ${tenantId}): enqueued ${row.type} from quarantined outbox row ${row.id}`);
            }
          } catch (err) {
            this.logger.error(`webhook reconcile (tenant ${tenantId}): outbox row ${row.id} failed — retried next tick: ${(err as Error).message}`);
          }
        }
      }

      return {
        stale: stale.length,
        expired: expired.length,
        heldExpired: heldExpired.length,
        heldOverflow,
        purgedDeliveries: purgedDeliveries.length,
        purgedEvents: purgedEvents.length,
        purgedEndpoints,
        departedEndpoints,
        reconciled,
        autoDisabled,
      };
    });
  }

  /** Disables every active endpoint of the departed clients (`client-departed`) and fails their pending rows. */
  private async disableDepartedInTx(tx: TenantTx, tenantId: string, clientIds: readonly string[]): Promise<number> {
    const disabled = await tx
      .update(webhookEndpoints)
      .set({ status: 'disabled', disabledReason: 'client-departed', disabledAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(webhookEndpoints.tenantId, tenantId), inArray(webhookEndpoints.clientId, [...clientIds]), eq(webhookEndpoints.status, 'active')))
      .returning({ id: webhookEndpoints.id });
    // Code review C9 — held rows too: an endpoint auto-disabled for failing
    // keeps its reason (and its panel entry, which a delete resolves), but a
    // departed client's held backlog is never sent.
    await tx.execute(sql`
      update webhook_deliveries
         set status = 'failed', last_error_code = 'client-departed', updated_at = now()
       where tenant_id = ${tenantId}::uuid and status in ('pending', 'held') and client_id = any(${sql.param([...clientIds])}::uuid[])
    `);
    for (const endpoint of disabled) {
      await this.auditSystemInTx(tx, tenantId, endpoint.id, { reason: 'client-departed' });
      this.logger.warn(`webhook endpoint ${endpoint.id} (tenant ${tenantId}) disabled: its client has departed`);
    }
    return disabled.length;
  }

  // ── 2. the claim ───────────────────────────────────────────────────────

  async claim(tenantId: string, limit: number): Promise<{ claimed: ClaimedDelivery[]; settled: number }> {
    if (limit <= 0) return { claimed: [], settled: 0 };
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // Code review C5 — one claim per tenant at a time across processes, so
      // the live `sending` count below cannot be read by two claimers at
      // once (the per-endpoint cap holds in two workers too). Transaction-
      // scoped; the claim is short.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wms:webhook-claim:${tenantId}`}, 0))`);
      // At most two `sending` per endpoint across ticks and processes, the
      // due rows interleaved round-robin across endpoints (A3).
      const candidates = (await tx.execute(sql`
        with live as (
          select endpoint_id, count(*)::int as n from webhook_deliveries
           where tenant_id = ${tenantId}::uuid and status = 'sending'
           group by endpoint_id
        ), ranked as (
          select d.id, d.endpoint_id, d.next_attempt_at,
                 row_number() over (partition by d.endpoint_id order by d.next_attempt_at, d.id) as rn
            from webhook_deliveries d
           where d.tenant_id = ${tenantId}::uuid and d.status = 'pending' and d.next_attempt_at <= now()
        )
        select r.id::text as "id"
          from ranked r left join live l on l.endpoint_id = r.endpoint_id
         where r.rn + coalesce(l.n, 0) <= ${WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT}
         order by r.rn, r.next_attempt_at, r.id
         limit ${limit}
      `)) as unknown as { id: string }[];
      if (candidates.length === 0) return { claimed: [], settled: 0 };
      const ids = candidates.map((row) => row.id);
      const locked = await tx
        .select({
          id: webhookDeliveries.id,
          endpointId: webhookDeliveries.endpointId,
          eventId: webhookDeliveries.eventId,
          clientId: webhookDeliveries.clientId,
          attempts: webhookDeliveries.attempts,
        })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.tenantId, tenantId), inArray(webhookDeliveries.id, ids), eq(webhookDeliveries.status, 'pending')))
        .orderBy(webhookDeliveries.id)
        .for('update', { skipLocked: true });
      if (locked.length === 0) return { claimed: [], settled: 0 };

      const endpointIds = [...new Set(locked.map((row) => row.endpointId))];
      const endpoints = new Map(
        (
          await tx
            .select({
              id: webhookEndpoints.id,
              status: webhookEndpoints.status,
              disabledReason: webhookEndpoints.disabledReason,
              eventTypes: webhookEndpoints.eventTypes,
            })
            .from(webhookEndpoints)
            .where(and(eq(webhookEndpoints.tenantId, tenantId), inArray(webhookEndpoints.id, endpointIds)))
        ).map((row) => [row.id, row]),
      );
      const eventTypes = new Map(
        (
          await tx
            .select({ id: webhookEvents.id, eventType: webhookEvents.eventType })
            .from(webhookEvents)
            .where(and(eq(webhookEvents.tenantId, tenantId), inArray(webhookEvents.id, [...new Set(locked.map((row) => row.eventId))])))
        ).map((row) => [row.id, row.eventType]),
      );
      const departed = await departedClientIdsInTx(tx, tenantId);
      const departedClients = [...new Set(locked.filter((row) => departed.has(row.clientId)).map((row) => row.clientId))];
      if (departedClients.length > 0) await this.disableDepartedInTx(tx, tenantId, departedClients);

      const claimedAt = nowIso();
      const claimed: ClaimedDelivery[] = [];
      let settled = 0;
      for (const row of locked) {
        const endpoint = endpoints.get(row.endpointId);
        const eventType = eventTypes.get(row.eventId);
        let fate: { status: 'failed' | 'held'; code: string } | null = null;
        if (departed.has(row.clientId)) fate = { status: 'failed', code: 'client-departed' };
        else if (endpoint === undefined || endpoint.status === 'deleted') fate = { status: 'failed', code: 'endpoint-deleted' };
        else if (endpoint.status === 'disabled') {
          fate = endpoint.disabledReason === 'failing' ? { status: 'held', code: 'endpoint-disabled' } : { status: 'failed', code: 'endpoint-disabled' };
        } else if (eventType === undefined || !endpoint.eventTypes.includes(eventType)) fate = { status: 'failed', code: 'unsubscribed' };
        if (fate !== null) {
          await tx
            .update(webhookDeliveries)
            .set(fate.status === 'held' ? { status: 'held', updatedAt: sql`now()` } : { status: 'failed', lastErrorCode: fate.code, updatedAt: sql`now()` })
            .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, 'pending')));
          settled += 1;
          continue;
        }
        await tx
          .update(webhookDeliveries)
          .set({ status: 'sending', claimedAt, updatedAt: sql`now()` })
          .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, 'pending')));
        claimed.push({ id: row.id, endpointId: row.endpointId, eventId: row.eventId, attempts: row.attempts, claimedAt });
      }
      return { claimed, settled };
    });
  }

  // ── 3. the sends ───────────────────────────────────────────────────────

  private async sendClaimed(
    tenantId: string,
    claimed: readonly ClaimedDelivery[],
    tick: WebhookTick,
    config: WebhookConfig,
  ): Promise<Omit<WebhookSendSummary, keyof WebhookSweepSummary | 'claimed' | 'settledAtClaim'>> {
    const transport = this.transportFor(config);
    const counts = { attempted: 0, succeeded: 0, retried: 0, failed: 0, released: 0 };
    const configCodes = new Set<string>();
    const released: ClaimedDelivery[] = [];
    await Promise.all(
      claimed.map((delivery) =>
        tick.pool.run(async () => {
          if (Date.now() >= tick.deadline) {
            released.push(delivery);
            return;
          }
          try {
            const kind = await this.sendOne(tenantId, delivery, transport);
            tick.onSend?.();
            if (kind === 'lost') return;
            if (kind === 'config') {
              configCodes.add('secret-unavailable');
              return;
            }
            counts.attempted += 1;
            counts[kind] += 1;
          } catch (err) {
            // A database fault around the send: the row stays `sending` and
            // the stale sweep returns it (at least once).
            this.logger.error(`webhook delivery ${delivery.id} (tenant ${tenantId}) — left to the stale sweep: ${(err as Error).message}`);
          }
        }),
      ),
    );
    if (released.length > 0) {
      // The tick budget ran out before these started: back to `pending`,
      // no attempt spent, in one final transaction.
      try {
        await withTenantTransaction(this.db, tenantId, async (tx) => {
          for (const delivery of released) {
            const rows = await tx
              .update(webhookDeliveries)
              .set({ status: 'pending', claimedAt: null, updatedAt: sql`now()` })
              .where(this.stillClaimed(delivery))
              .returning({ id: webhookDeliveries.id });
            counts.released += rows.length;
          }
        });
      } catch (err) {
        this.logger.error(`webhook release (tenant ${tenantId}) failed — the stale sweep returns the rows: ${(err as Error).message}`);
      }
    }
    return { ...counts, configCodes: [...configCodes].sort() };
  }

  private stillClaimed(delivery: ClaimedDelivery) {
    return and(
      eq(webhookDeliveries.id, delivery.id),
      eq(webhookDeliveries.status, 'sending'),
      sql`${webhookDeliveries.claimedAt} = ${delivery.claimedAt}::timestamptz`,
    );
  }

  /** One delivery: re-read, sign, send, write the outcome. */
  private async sendOne(tenantId: string, delivery: ClaimedDelivery, transport: WebhookTransport): Promise<OutcomeKind> {
    const live = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          url: webhookEndpoints.url,
          status: webhookEndpoints.status,
          disabledReason: webhookEndpoints.disabledReason,
          secretSealed: webhookEndpoints.secretSealed,
          previousSecretSealed: webhookEndpoints.previousSecretSealed,
          previousSecretExpiresAt: webhookEndpoints.previousSecretExpiresAt,
          body: webhookEvents.body,
          eventId: webhookEvents.id,
        })
        .from(webhookDeliveries)
        .innerJoin(webhookEndpoints, and(eq(webhookEndpoints.tenantId, webhookDeliveries.tenantId), eq(webhookEndpoints.id, webhookDeliveries.endpointId)))
        .innerJoin(webhookEvents, and(eq(webhookEvents.tenantId, webhookDeliveries.tenantId), eq(webhookEvents.id, webhookDeliveries.eventId)))
        .where(this.stillClaimed(delivery))
        .limit(1);
      return rows[0] ?? null;
    });
    if (live === null) return 'lost';
    if (live.status !== 'active') {
      // Disabled or deleted between the claim and the send: never sent.
      // Code review C3 — the claim's own rule: an endpoint auto-disabled for
      // FAILING (often by a sibling send this very tick) holds the row, so a
      // re-enable's release sends it.
      const held = live.status === 'disabled' && live.disabledReason === 'failing';
      await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .update(webhookDeliveries)
          .set(
            held
              ? { status: 'held', claimedAt: null, updatedAt: sql`now()` }
              : { status: 'failed', claimedAt: null, lastErrorCode: live.status === 'deleted' ? 'endpoint-deleted' : 'endpoint-disabled', updatedAt: sql`now()` },
          )
          .where(this.stillClaimed(delivery)),
      );
      return 'lost';
    }

    let keys: Buffer[];
    try {
      keys = openSigningKeys(
        {
          tenantId,
          endpointId: delivery.endpointId,
          secretSealed: live.secretSealed,
          previousSecretSealed: live.previousSecretSealed,
          previousSecretExpiresAt: live.previousSecretExpiresAt,
        },
        Date.now(),
      );
    } catch {
      // A17 — a CONFIG fault: no attempt spent, retried in 60 s, never
      // counted; the rows expire on the normal clock.
      await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .update(webhookDeliveries)
          .set({
            status: 'pending',
            claimedAt: null,
            lastErrorCode: 'secret-unavailable',
            nextAttemptAt: sql`now() + ${secs(WEBHOOK_CONFIG_FAULT_RETRY_MS)}`,
            updatedAt: sql`now()`,
          })
          .where(this.stillClaimed(delivery)),
      );
      return 'config';
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const outcome = await transport.post(live.url, webhookHeaders(keys, live.eventId, timestamp, live.body), live.body);
    const kind = await withTenantTransaction(this.db, tenantId, (tx) => this.writeOutcomeInTx(tx, tenantId, delivery, outcome));
    if (kind !== 'succeeded' && kind !== 'lost') {
      this.logger.warn(
        `webhook delivery ${delivery.id} (tenant ${tenantId}, endpoint ${delivery.endpointId}, host ${webhookHostOf(live.url)}): ` +
          `${outcomeErrorCode(outcome) ?? 'error'} → ${kind}`,
      );
    }
    return kind;
  }

  // ── 4. outcomes ────────────────────────────────────────────────────────

  /** One outcome, written only while the row is still `sending` under its claim stamp. */
  async writeOutcomeInTx(tx: TenantTx, tenantId: string, delivery: ClaimedDelivery, outcome: WebhookSendOutcome): Promise<OutcomeKind> {
    const fate = classifyOutcome(outcome);
    const attempts = delivery.attempts + 1;
    const recorded = {
      attempts,
      claimedAt: null,
      lastAttemptAt: sql`now()`,
      lastStatusCode: outcomeStatusCode(outcome),
      lastErrorCode: outcomeErrorCode(outcome),
      lastDurationMs: Math.max(0, Math.round(outcome.durationMs)),
      updatedAt: sql`now()`,
    };
    const write = async (set: Record<string, unknown>): Promise<boolean> =>
      (
        await tx
          .update(webhookDeliveries)
          .set({ ...recorded, ...set })
          .where(this.stillClaimed(delivery))
          .returning({ id: webhookDeliveries.id })
      ).length > 0;

    if (fate.kind === 'succeeded') {
      if (!(await write({ status: 'succeeded', succeededAt: sql`now()` }))) return 'lost';
      await tx
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, failingSince: null, lastSuccessAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, delivery.endpointId), eq(webhookEndpoints.status, 'active')));
      return 'succeeded';
    }
    if (fate.kind === 'gone') {
      if (!(await write({ status: 'failed' }))) return 'lost';
      await this.autoDisableInTx(tx, tenantId, delivery.endpointId, 'gone');
      return 'failed';
    }
    if (fate.kind === 'failed') {
      if (!(await write({ status: 'failed' }))) return 'lost';
      await this.countFinalFailuresInTx(tx, tenantId, delivery.endpointId, 1);
      return 'failed';
    }
    if (attempts < WEBHOOK_MAX_ATTEMPTS) {
      const retryAfterMs = outcome.kind === 'response' ? outcome.retryAfterMs : null;
      const honoured = outcome.kind === 'response' && (outcome.statusCode === 429 || outcome.statusCode === 503) ? retryAfterMs : null;
      const waitMs = webhookNextWaitMs(attempts, honoured, this.random);
      if (!(await write({ status: 'pending', nextAttemptAt: sql`now() + ${secs(waitMs)}` }))) return 'lost';
      return 'retried';
    }
    if (!(await write({ status: 'failed' }))) return 'lost';
    if (fate.countsWhenFinal) await this.countFinalFailuresInTx(tx, tenantId, delivery.endpointId, 1);
    return 'failed';
  }

  /**
   * A12 — counts `n` FINAL failures against an ACTIVE endpoint atomically,
   * then decides the auto-disable under `FOR UPDATE` on the endpoint row (the
   * sender locks only the endpoint; commands lock the client first, then the
   * endpoint — no cycle). True when it disabled the endpoint.
   */
  async countFinalFailuresInTx(tx: TenantTx, tenantId: string, endpointId: string, n: number): Promise<boolean> {
    const counted = await tx
      .update(webhookEndpoints)
      .set({
        consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + ${n}::int`,
        failingSince: sql`coalesce(${webhookEndpoints.failingSince}, now())`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.status, 'active')))
      .returning({ id: webhookEndpoints.id });
    if (counted.length === 0) return false;
    const locked = await tx
      .select({ status: webhookEndpoints.status, consecutiveFailures: webhookEndpoints.consecutiveFailures, failingSince: webhookEndpoints.failingSince })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpointId)))
      .for('update');
    const row = locked[0];
    if (row === undefined || row.status !== 'active') return false;
    // The database's clock, the one `failing_since` was stamped with.
    const dbNow = (await tx.execute(sql`select (extract(epoch from now()) * 1000)::float8 as "ms"`)) as unknown as { ms: number }[];
    if (!shouldAutoDisable(row.consecutiveFailures, row.failingSince, Number(dbNow[0]!.ms))) return false;
    return this.autoDisableInTx(tx, tenantId, endpointId, 'failing');
  }

  /**
   * Disables an ACTIVE endpoint for `failing` (its pending rows → `held`,
   * A5) or `gone` (→ `failed endpoint-disabled`), with a fresh panel
   * episode: audited under the system actor and raised as
   * `webhook_endpoint.disabled`. True when it changed the row.
   */
  private async autoDisableInTx(tx: TenantTx, tenantId: string, endpointId: string, reason: Extract<WebhookDisabledReason, 'failing' | 'gone'>): Promise<boolean> {
    const episodeId = uuidv7();
    const rows = await tx
      .update(webhookEndpoints)
      .set({ status: 'disabled', disabledReason: reason, disabledAt: sql`now()`, disabledEpisodeId: episodeId, updatedAt: sql`now()` })
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.status, 'active')))
      .returning({ id: webhookEndpoints.id, clientId: webhookEndpoints.clientId, url: webhookEndpoints.url });
    const endpoint = rows[0];
    if (endpoint === undefined) return false;
    if (reason === 'failing') {
      await tx.execute(sql`
        update webhook_deliveries set status = 'held', updated_at = now()
         where tenant_id = ${tenantId}::uuid and endpoint_id = ${endpointId}::uuid and status = 'pending'
      `);
      await trimHeldInTx(tx, tenantId, [endpointId]);
    } else {
      await tx.execute(sql`
        update webhook_deliveries set status = 'failed', last_error_code = 'endpoint-disabled', updated_at = now()
         where tenant_id = ${tenantId}::uuid and endpoint_id = ${endpointId}::uuid and status = 'pending'
      `);
    }
    await this.auditSystemInTx(tx, tenantId, endpointId, { reason, episodeId });
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: WEBHOOK_DISABLED_EVENT,
      occurredAt: nowIso(),
      payload: { endpointId, clientId: endpoint.clientId, episodeId, reason, host: webhookHostOf(endpoint.url) },
    });
    this.logger.warn(`webhook endpoint ${endpointId} (tenant ${tenantId}, host ${webhookHostOf(endpoint.url)}) auto-disabled: ${reason}`);
    return true;
  }

  private async auditSystemInTx(tx: TenantTx, tenantId: string, endpointId: string, changes: Record<string, unknown>): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId: SYSTEM_ACTOR_ID,
      action: 'webhook_endpoint.auto_disabled',
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      reference: null,
      changes,
      occurredAt: nowIso(),
    });
  }

  /** The synchronous test send (A4): one signed POST, no row written here. */
  async sendTest(url: string, keys: readonly Buffer[], body: string, id: string, config: WebhookConfig): Promise<WebhookSendOutcome> {
    return this.transportFor(config).post(url, webhookHeaders(keys, id, Math.floor(Date.now() / 1000), body), body);
  }
}

function zeroSends(): Omit<WebhookSendSummary, keyof WebhookSweepSummary> {
  return { claimed: 0, attempted: 0, succeeded: 0, retried: 0, failed: 0, released: 0, settledAtClaim: 0, configCodes: [] };
}

export { EMPTY_SWEEP };
