import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { AUTH_DATABASE, DATABASE } from '../db/tokens';
import type { Database } from '../db/db';
import { outboxMessages } from '../db/schema';
import type { OutboxMessageRow } from '../db/schema';
import { nowIso } from '../primitives/time';
import { withTenantTransaction, type TenantTx } from '../db/tenant-scope';
import type { DomainEvent, EventBus } from './event-bus.seam';
import { EVENT_BUS } from './event-bus';
import type { OutboxMessage, OutboxRelay, OutboxSink } from './outbox.seam';

/**
 * Retry budget (spec): a row quarantines after N=5 failed attempts and
 * re-drains only by operator action.
 */
export const OUTBOX_MAX_ATTEMPTS = 5;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Exponential backoff after the Nth failure: `min(2^(attempts-1) · 5s, 5min)`
 * (attempts is the failure count AFTER the increment: 5s, 10s, 20s, 40s…).
 */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

/**
 * Session advisory-lock key: one relay drain cycle at a time across all
 * relay instances (a session-level `pg_try_advisory_lock`, not transaction
 * scoped — the lock must span the whole cycle, not one tenant transaction).
 */
const RELAY_LOCK_SQL_KEY = 'wms:outbox-relay';

/**
 * Operator replay path (the DLQ exit; deliberately no HTTP surface — run as
 * the table owner via psql):
 *
 *   UPDATE outbox_messages
 *   SET status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
 *   WHERE id = $1 AND status = 'quarantined';
 *
 * The next drain cycle re-publishes the row at-least-once.
 */
export const OUTBOX_OPERATOR_REPLAY_SQL = `update outbox_messages
  set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
  where id = $1 and status = 'quarantined'`;

/**
 * The write side of the outbox (AD-7): one `append` per domain event, called
 * INSIDE the command's tenant transaction so the event commits (or rolls
 * back) with the write that produced it — never post-commit. The row is
 * `pending` on arrival; suppression parity is structural: every command
 * reaches `append` only on its fresh-write path, so an idempotent replay
 * (which returns the snapshot before any append) writes no second row.
 */
@Injectable()
export class PostgresOutboxSink implements OutboxSink {
  async append(tx: TenantTx, message: OutboxMessage): Promise<void> {
    await tx.insert(outboxMessages).values({
      id: message.messageId,
      tenantId: message.tenantId,
      type: message.type,
      payload: message.payload,
      occurredAt: message.occurredAt,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: nowIso(),
    });
  }
}

/**
 * The read/deliver side: one `drain(limit)` call is one relay cycle.
 *
 * A cycle takes a session-level advisory lock (`pg_try_advisory_lock` — a
 * concurrent cycle sheds immediately and returns []), discovers tenants with
 * due pending rows oldest-first, and — inside that lock — walks each tenant
 * through an explicitly tenant-scoped transaction (AD-3): batch rows
 * `(created_at, id)`-ordered, publish each through `EVENT_BUS`, delete the
 * row on ack. A throwing bus leaves the row pending with attempts+1, a
 * computed backoff, and the last error recorded; later rows still drain.
 * Past `OUTBOX_MAX_ATTEMPTS` the row quarantines.
 *
 * Delivery is at-least-once: a crash between publish and ack re-publishes on
 * the next cycle (consumers own exactly-once effect, AD-5); the relayed
 * `DomainEvent.eventId` IS the outbox row id, so consumers can correlate and
 * de-dupe.
 *
 * RLS note: the table's policy is fail-closed (0007), so tenant discovery —
 * the one deliberately cross-tenant read — runs on the BYPASSRLS connection
 * (the `AUTH_DATABASE` role's sanctioned second use, read-only; every row
 * mutation stays in a tenant-scoped transaction on `DATABASE`).
 */
@Injectable()
export class PostgresOutboxRelay implements OutboxRelay {
  private readonly logger = new Logger('OutboxRelay');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async drain(limit: number): Promise<readonly OutboxMessage[]> {
    if (limit <= 0) {
      return [];
    }
    // Session advisory lock: postgres.js reserves one dedicated connection
    // for the whole cycle so the lock (and its release) land on the same
    // session — the shared pool's statements may round-robin connections.
    const session = await (this.db as unknown as { $client: Sql }).$client.reserve();
    try {
      const lockRows = (await session`
        select pg_try_advisory_lock(hashtextextended(${RELAY_LOCK_SQL_KEY}, 0)) as locked
      `) as unknown as { locked: boolean }[];
      if (!lockRows[0]?.locked) {
        // Another relay instance holds the cycle — shed (AD-17).
        return [];
      }
      try {
        return await this.drainLocked(limit);
      } finally {
        await session`select pg_advisory_unlock(hashtextextended(${RELAY_LOCK_SQL_KEY}, 0))`;
      }
    } finally {
      session.release();
    }
  }

  /** Caller holds the relay's session advisory lock. */
  private async drainLocked(limit: number): Promise<OutboxMessage[]> {
    const published: OutboxMessage[] = [];
    // Tenant discovery — the one cross-tenant read (BYPASSRLS connection,
    // read-only): tenants with due pending rows, oldest activity first.
    const tenantRows = (await this.authDb.execute(sql`
      select tenant_id, min(created_at) as oldest_at
      from outbox_messages
      where status = 'pending' and next_attempt_at <= now()
      group by tenant_id
      order by oldest_at asc
    `)) as unknown as { tenant_id: string }[];

    for (const { tenant_id: tenantId } of tenantRows) {
      if (published.length >= limit) {
        break;
      }
      // Per-tenant batch under the tenant scope (AD-3): due rows only,
      // oldest-first within the tenant.
      const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .select()
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.tenantId, tenantId),
              eq(outboxMessages.status, 'pending'),
              sql`${outboxMessages.nextAttemptAt} <= now()`,
            ),
          )
          .orderBy(asc(outboxMessages.createdAt), asc(outboxMessages.id))
          .limit(limit - published.length),
      );
      for (const row of rows) {
        if (published.length >= limit) {
          break;
        }
        const message = await this.deliver(row);
        if (message) {
          published.push(message);
        }
      }
    }
    return published;
  }

  /**
   * Publish one row through the bus; delete on ack. A throwing bus marks the
   * row failed (attempts/backoff/last_error — quarantining past the budget)
   * and returns undefined so later rows still drain.
   */
  private async deliver(row: OutboxMessageRow): Promise<OutboxMessage | undefined> {
    const event: DomainEvent = {
      // The outbox row id IS the event id: a logged publish always
      // correlates back to its outbox row (and re-delivery keeps it).
      eventId: row.id,
      type: row.type,
      tenantId: row.tenantId,
      occurredAt: new Date(row.occurredAt).toISOString(),
      payload: row.payload,
    };
    try {
      await this.eventBus.publish(event);
    } catch (error) {
      await this.markFailed(row, error);
      return undefined;
    }
    await withTenantTransaction(this.db, row.tenantId, (tx) =>
      tx
        .delete(outboxMessages)
        .where(and(eq(outboxMessages.id, row.id), eq(outboxMessages.status, 'pending'))),
    );
    return {
      messageId: row.id,
      tenantId: row.tenantId,
      type: row.type,
      payload: row.payload,
      occurredAt: event.occurredAt,
      publishedAt: nowIso(),
    };
  }

  /** Bookkeeping for one failed publish — in the row's own tenant tx. */
  private async markFailed(row: OutboxMessageRow, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const quarantined = attempts >= OUTBOX_MAX_ATTEMPTS;
    const nextAttemptAt = quarantined
      ? row.nextAttemptAt // kept (column is NOT NULL); the row is due again only via operator replay
      : new Date(Date.now() + outboxBackoffMs(attempts)).toISOString();
    await withTenantTransaction(this.db, row.tenantId, (tx) =>
      tx
        .update(outboxMessages)
        .set({
          status: quarantined ? 'quarantined' : 'pending',
          attempts,
          nextAttemptAt,
          lastError: errorMessage(error),
          updatedAt: nowIso(),
        })
        .where(and(eq(outboxMessages.id, row.id), eq(outboxMessages.status, 'pending'))),
    );
    this.logger.warn(
      `Outbox publish failed (attempts=${attempts}${quarantined ? ', quarantined' : ''}) ` +
        `type=${row.type} tenant=${row.tenantId} message=${row.id}`,
    );
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
}