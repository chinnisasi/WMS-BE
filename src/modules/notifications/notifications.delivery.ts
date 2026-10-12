import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { notifications } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  EVENT_ROUTES,
  decodeRaise,
  decodeResolve,
  type DecodedRaise,
  type EventRoute,
} from './notification-sources';

/** The `occurredAt` the relay stamps: an ISO-8601 UTC instant. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Story 9-2 — the notification panel's projection writer: one idempotent
 * outbox subscriber per source event (the `invoicing/eway.delivery.ts`
 * template). Each raise event inserts an entry keyed by the occurrence's
 * own id; each resolve event stamps it resolved.
 *
 * Postures:
 *  - it subscribes in `onModuleInit`, decodes ids (and the summary's
 *    allowlisted keys) only, and writes in its OWN tenant transaction;
 *  - **raise** — an upsert on `(tenant_id, source_type, source_id)`: a new
 *    row takes `raised_at` from the event's `occurredAt`, `surfaced_at =
 *    now()` and its summary; a TOMBSTONE (a resolve that arrived first) is
 *    filled the same way and keeps its `resolved_at`; a row that already has
 *    a summary is a re-delivery and changes nothing;
 *  - **resolve** — stamps `resolved_at` (the event's `occurredAt`) and
 *    `resolution` when not already set; with no row it inserts a tombstone so
 *    the late raise cannot reopen a settled entry — EXCEPT the designed
 *    no-op (an under-threshold count variance, which was never raised);
 *  - a malformed payload, a `ProblemException` < 500 and an SQLSTATE class
 *    22 (data exception) or 23 (integrity violation) ACK and log — no retry
 *    can fix them; anything else RETHROWS so the relay re-delivers (safe: no
 *    other subscriber exists on these types today, and the writes are
 *    idempotent);
 *  - no outbox events of its own, no audit (no actor — the `delivery.ts`
 *    rule).
 */
@Injectable()
export class NotificationsDeliveryHandler implements OnModuleInit {
  private readonly logger = new Logger(NotificationsDeliveryHandler.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    for (const type of EVENT_ROUTES.keys()) {
      this.eventBus.subscribe(type, (event) => this.deliver(event));
    }
  }

  /** One delivery attempt (a relay publish is one invocation, at-least-once). */
  async deliver(event: DomainEvent): Promise<void> {
    const route = EVENT_ROUTES.get(event.type);
    if (route === undefined) return;
    if (typeof event.occurredAt !== 'string' || !INSTANT_RE.test(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
      this.logger.error(`${event.type} ${event.eventId}: malformed occurredAt — acking, not retrying`);
      return;
    }
    try {
      await this.apply(route, event);
    } catch (err) {
      if (isDataFault(err)) {
        this.logger.error(
          `${event.type} ${event.eventId}: notification projection hit a data fault — acking: ${(err as Error).message}`,
        );
        return;
      }
      this.logger.error(`${event.type} ${event.eventId}: notification projection failed — retrying via relay`);
      throw err;
    }
  }

  private async apply(route: EventRoute, event: DomainEvent): Promise<void> {
    if (route.arm === 'raise') {
      const raise = decodeRaise(route, event.payload);
      if (raise === null) {
        this.logger.error(`${event.type} ${event.eventId}: malformed payload — acking, not retrying`);
        return;
      }
      await this.raise(event.tenantId, raise, event.occurredAt);
      return;
    }
    const resolve = decodeResolve(route, event.payload);
    if (resolve === null) {
      this.logger.error(`${event.type} ${event.eventId}: malformed payload — acking, not retrying`);
      return;
    }
    if (resolve.kind === 'ignore') return;
    await withTenantTransaction(this.db, event.tenantId, async (tx) => {
      await tx
        .insert(notifications)
        .values({
          id: uuidv7(),
          tenantId: event.tenantId,
          sourceType: resolve.sourceType,
          sourceId: resolve.sourceId,
          warehouseId: resolve.warehouseId,
          summary: null,
          raisedAt: null,
          surfacedAt: null,
          resolvedAt: event.occurredAt,
          resolution: resolve.resolution,
        })
        .onConflictDoUpdate({
          target: [notifications.tenantId, notifications.sourceType, notifications.sourceId],
          set: {
            resolvedAt: event.occurredAt,
            resolution: resolve.resolution,
            updatedAt: sql`now()`,
          },
          // Resolved once: a re-delivery (or a second resolve) changes nothing.
          setWhere: sql`${notifications.resolvedAt} is null`,
        });
    });
  }

  private async raise(tenantId: string, raise: DecodedRaise, occurredAt: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      await tx
        .insert(notifications)
        .values({
          id: uuidv7(),
          tenantId,
          sourceType: raise.sourceType,
          sourceId: raise.sourceId,
          warehouseId: raise.warehouseId,
          summary: { ...raise.summary },
          raisedAt: occurredAt,
          surfacedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [notifications.tenantId, notifications.sourceType, notifications.sourceId],
          // Filling a tombstone: the raise's facts land, `resolved_at` and
          // `resolution` stay — the entry reads resolved and lights no dot.
          set: {
            warehouseId: raise.warehouseId,
            summary: { ...raise.summary },
            raisedAt: occurredAt,
            surfacedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          // A row that already has a summary is a re-delivery: no change.
          setWhere: sql`${notifications.summary} is null`,
        });
    });
  }
}

/**
 * A failure no retry can fix: a client-class problem, or a Postgres data
 * exception (SQLSTATE class 22) / integrity violation (class 23) anywhere on
 * the error's `cause` chain (drizzle wraps the driver's error).
 */
function isDataFault(err: unknown): boolean {
  if (err instanceof ProblemException) return err.getStatus() < 500;
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
