import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { EVENT_BUS } from '../../shared/events/event-bus';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { pushDeliveries } from '../../shared/db/schema';
import { UUID_RE, uuidv7TimestampMs } from '../../shared/primitives/ids';
import { istMidnightOf, isIsoDate } from '../../shared/primitives/time';
import { listPushTargets } from '../tenancy/tenancy.service';
import { NOTIFICATION_SOURCES, decodeRaise, EVENT_ROUTES } from './notification-sources';
import { isDataFault } from './notifications.delivery';
import {
  APPROVAL_PUSH_SOURCES,
  PUSH_STALE_EVENT_MS,
  pushAudienceAllows,
  pushClock,
  type ApprovalPushSource,
  type PushAudienceFacts,
  type PushKind,
  type PushTab,
} from './push-rules';

/** The `occurredAt` the relay stamps: an ISO-8601 UTC instant. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CUTOFF_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * The emitters' event types — repeated as literals because this module may
 * import no sibling's internals (AD-6), and pinned equal to the emitters by
 * `test/push.spec.ts`.
 */
export const PUSH_WAVE_RELEASED_EVENT = 'wave.released';
export const PUSH_COUNT_CREATED_EVENT = 'count.created';
export const PUSH_TRANSFER_CONFIRMED_EVENT = 'transfer.outbound-confirmed';
export const PUSH_WAVE_CUTOFF_AT_RISK_EVENT = 'wave.cutoff_at_risk';

/** What one event asks to queue (null = nothing to push). */
interface PushIntent {
  readonly kind: PushKind;
  readonly tab: PushTab;
  readonly facts: PushAudienceFacts;
}

type Payload = Record<string, unknown>;

function uuidField(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function newWork(tab: PushTab, warehouseId: string | null): PushIntent | null {
  return warehouseId === null ? null : { kind: 'new-work', tab, facts: { kind: 'new-work', warehouseId, approvalSource: null } };
}

/**
 * The approval raise event of each approval source — read from the 9-2
 * source table (reused, never re-derived).
 */
const APPROVAL_RAISES: ReadonlyMap<string, ApprovalPushSource> = new Map(
  APPROVAL_PUSH_SOURCES.map((source) => [NOTIFICATION_SOURCES[source].raise.type, source] as const),
);

/**
 * The cutoff instant of an at-risk event: its IST date at its `HH:MM`
 * (IST is UTC+05:30 year-round — `WAVE_CUTOFF_TIMEZONE`). Null = malformed.
 */
function cutoffInstantMs(payload: Payload): number | null {
  const istDate = payload.istDate;
  const cutoff = payload.cutoffLocalTime;
  if (typeof istDate !== 'string' || !isIsoDate(istDate) || typeof cutoff !== 'string') return null;
  const match = CUTOFF_RE.exec(cutoff);
  if (match === null) return null;
  return Date.parse(istMidnightOf(istDate)) + (Number(match[1]) * 60 + Number(match[2])) * 60_000;
}

/**
 * Story 9-2b — the push QUEUE writer: one outbox subscriber that turns the
 * relevant events into `pending` `push_deliveries` rows, one per eligible
 * handheld. It NEVER calls the network (the `PushSenderWorker` sends) — the
 * relay is one serial loop for every tenant, and a provider outage inside a
 * handler would stall it and, past five throws, quarantine rows the 9-2
 * projection shares.
 *
 * Events → kind / tab:
 *  - `wave.released` → new-work · Pick (the wave's warehouse);
 *  - `count.created` with origin `on_demand` or `recount` → new-work · Count
 *    (a SCHEDULED count is never pushed — one tick can create dozens);
 *  - `transfer.outbound-confirmed` → new-work · Transfer (the DESTINATION
 *    warehouse — the inbound side's new work);
 *  - the three approval raises (`APPROVAL_PUSH_SOURCES`) → approval · All;
 *  - `wave.cutoff_at_risk` → at-risk · All, acked when its cutoff has passed.
 *
 * An event APPENDED more than 30 minutes ago (the uuidv7 timestamp of its
 * outbox row id — never its `occurredAt`, which can be device time) is acked
 * without queueing (a deploy's backlog, an operator's replay of a quarantined row):
 * a stale "new work" push is noise. The insert is `ON CONFLICT DO NOTHING`
 * on `(tenant_id, event_id, device_id)`, so a re-delivered event queues
 * nothing new. Errors: a malformed payload and a data fault (the 9-2
 * handler's `isDataFault`) ack; anything else rethrows — safe, because every
 * subscriber on these types is idempotent, and the 9-2 projection
 * subscribes FIRST (provider order in `notifications.module.ts`), so its
 * entry is written before this handler can throw.
 */
@Injectable()
export class PushEnqueueHandler implements OnModuleInit {
  private readonly logger = new Logger(PushEnqueueHandler.name);

  constructor(
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    for (const type of [
      PUSH_WAVE_RELEASED_EVENT,
      PUSH_COUNT_CREATED_EVENT,
      PUSH_TRANSFER_CONFIRMED_EVENT,
      PUSH_WAVE_CUTOFF_AT_RISK_EVENT,
      ...APPROVAL_RAISES.keys(),
    ]) {
      this.eventBus.subscribe(type, (event) => this.deliver(event));
    }
  }

  /** One delivery attempt (at-least-once — the insert is idempotent). */
  async deliver(event: DomainEvent): Promise<void> {
    if (typeof event.occurredAt !== 'string' || !INSTANT_RE.test(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
      this.logger.error(`${event.type} ${event.eventId}: malformed occurredAt — no push`);
      return;
    }
    const now = pushClock.now();
    // The age is the SERVER's: the outbox row id (`eventId`) is a uuidv7
    // minted at append (`outbox.append` callers all mint `uuidv7()`; the relay
    // carries `row.id` as `eventId`). `occurredAt` is business time and can be
    // device time (a count, a transfer confirm queued offline) — never the
    // clock here (spec Staleness, amended 2026-10-12, code review BE1).
    const appendedAt = uuidv7TimestampMs(event.eventId);
    if (appendedAt === null) {
      this.logger.error(`${event.type} ${event.eventId}: event id is not a uuidv7 — cannot date it, no push`);
      return;
    }
    if (now - appendedAt > PUSH_STALE_EVENT_MS) {
      // A deploy backlog or an operator replay: acked, never pushed.
      return;
    }
    const intent = this.intentOf(event, now);
    if (intent === null) return;
    try {
      await this.enqueue(event, intent);
    } catch (err) {
      if (isDataFault(err)) {
        this.logger.error(`${event.type} ${event.eventId}: push enqueue hit a data fault — acking: ${(err as Error).message}`);
        return;
      }
      this.logger.error(`${event.type} ${event.eventId}: push enqueue failed — retrying via relay`);
      throw err;
    }
  }

  private intentOf(event: DomainEvent, now: number): PushIntent | null {
    const payload: Payload =
      typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) ? event.payload : {};
    switch (event.type) {
      case PUSH_WAVE_RELEASED_EVENT: {
        const wave = payload.wave;
        return newWork('Pick', typeof wave === 'object' && wave !== null ? uuidField(wave as Payload, 'warehouseId') : null);
      }
      case PUSH_COUNT_CREATED_EVENT:
        // Scheduled counts are never pushed; an unknown origin is not either.
        if (payload.origin !== 'on_demand' && payload.origin !== 'recount') return null;
        return newWork('Count', uuidField(payload, 'warehouseId'));
      case PUSH_TRANSFER_CONFIRMED_EVENT:
        return newWork('Transfer', uuidField(payload, 'destWarehouseId'));
      case PUSH_WAVE_CUTOFF_AT_RISK_EVENT: {
        const cutoff = cutoffInstantMs(payload);
        if (cutoff === null || uuidField(payload, 'waveId') === null) {
          this.logger.error(`${event.type} ${event.eventId}: malformed payload — no push`);
          return null;
        }
        // The cutoff has passed: the warning is moot.
        if (now >= cutoff) return null;
        return { kind: 'at-risk', tab: 'All', facts: { kind: 'at-risk', warehouseId: null, approvalSource: null } };
      }
      default: {
        const source = APPROVAL_RAISES.get(event.type);
        const route = EVENT_ROUTES.get(event.type);
        if (source === undefined || route === undefined || route.arm !== 'raise') return null;
        // The 9-2 decoder decides well-formedness — a payload the panel would
        // refuse is not pushed either.
        if (decodeRaise(route, event.payload) === null) return null;
        return { kind: 'approval', tab: 'All', facts: { kind: 'approval', warehouseId: null, approvalSource: source } };
      }
    }
  }

  private async enqueue(event: DomainEvent, intent: PushIntent): Promise<void> {
    await withTenantTransaction(this.db, event.tenantId, async (tx) => {
      const targets = (await listPushTargets(tx, event.tenantId)).filter((target) =>
        pushAudienceAllows(target, intent.facts),
      );
      if (targets.length === 0) return;
      await tx
        .insert(pushDeliveries)
        .values(
          targets.map((target) => ({
            tenantId: event.tenantId,
            eventId: event.eventId,
            deviceId: target.deviceId,
            kind: intent.kind,
            tab: intent.tab,
            warehouseId: intent.facts.kind === 'new-work' ? intent.facts.warehouseId : null,
            approvalSource: intent.facts.approvalSource,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: sql`now()`,
          })),
        )
        .onConflictDoNothing({ target: [pushDeliveries.tenantId, pushDeliveries.eventId, pushDeliveries.deviceId] });
    });
  }
}
