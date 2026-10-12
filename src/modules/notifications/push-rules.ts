import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import { isFloorRole } from '../tenancy/permissions';
import type { UserRole } from '../../shared/db/schema';
import { SOURCE_AUDIENCE, visibleSourceTypes } from './notification-sources';

/**
 * Story 9-2b — the mobile pushes' rules, as data: the vocabularies (mirrored
 * by the CHECKs in `drizzle/0068_mobile_pushes.sql` and pinned together by
 * `test/push.spec.ts` — IMPLEMENTATION-GUIDE §4), each kind's audience, the
 * fixed copy, the send-outcome classification and the timing constants.
 * Pure: no database, no network.
 */

/** What a push is about. Story 9.2 restricts mobile pushes to exactly these three (UX-DR25). */
export const PUSH_KINDS = ['new-work', 'approval', 'at-risk'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * The inbox tab a tap opens — the handheld's `TaskTab` spelling, exactly
 * (case-sensitive). `All` is the tab for anything that is not one task type.
 */
export const PUSH_TABS = ['Pick', 'Count', 'Transfer', 'All'] as const;
export type PushTab = (typeof PUSH_TABS)[number];

/** A delivery row's lifecycle: `pending → sending → sent | failed` (and `sending → pending` on a transient outcome). */
export const PUSH_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type PushDeliveryStatus = (typeof PUSH_DELIVERY_STATUSES)[number];

/** The `PushGateway` modes — the `PUSH_GATEWAY` env value, and the `gateway` column a sent row records. */
export const PUSH_GATEWAY_MODES = ['unconfigured', 'expo'] as const;
export type PushGatewayMode = (typeof PUSH_GATEWAY_MODES)[number];

/**
 * The 9-2 sources that are APPROVALS — a decision someone must take on the
 * web. A subset of `NOTIFICATION_SOURCE_TYPES`; the rejected op is a review,
 * not an approval, and UX-DR25 keeps it off the handheld.
 */
export const APPROVAL_PUSH_SOURCES = ['stock-adjustment', 'count-variance', 'over-receipt'] as const;
export type ApprovalPushSource = (typeof APPROVAL_PUSH_SOURCES)[number];

// ── timing ──────────────────────────────────────────────────────────────────

/** An event relayed later than this after its `occurredAt` is acked without queueing (deploy backlog, operator replays). */
export const PUSH_STALE_EVENT_MS = 30 * 60_000;
/** Expo drops a message it could not deliver within this many seconds. */
export const PUSH_TTL_SECONDS = 3600;
/** A row claimed `sending` longer than this was in flight when the process died: `failed` (`stale`), never re-sent. */
export const PUSH_SENDING_STALE_MS = 5 * 60_000;
/** A transient outcome is retried at most this many attempts in all; the next one is `failed`. */
export const PUSH_MAX_ATTEMPTS = 5;
/** A row still failing on a CONFIG fault this long after it was queued is `failed`. */
export const PUSH_CONFIG_FAULT_MAX_AGE_MS = 60 * 60_000;
/** How long a config-faulted row waits before the next try (a config fault spends no attempt). */
export const PUSH_CONFIG_FAULT_RETRY_MS = 30_000;
/** One send is at most this many messages (Expo's per-request limit), and a claim takes at most this many rows. */
export const PUSH_BATCH_SIZE = 100;
/** The `error_code` of the three rows the sender fails on its own (not a gateway code). */
export const PUSH_LOCAL_FAILURES = ['stale', 'ineligible', 'superseded'] as const;

/** Backoff after the Nth transient failure: `min(2^(attempts-1) · 5 s, 5 min)` — the outbox relay's curve. */
export function pushBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 5 * 60_000);
}

/**
 * The clock the push rules read (`now` for the staleness ack and the
 * at-risk cutoff check). An exported, assignable object — the
 * `rateCardClock` precedent (IMPLEMENTATION-GUIDE §7c): tests assign `now`,
 * never spy on it.
 */
export const pushClock = { now: (): number => Date.now() };

// ── the copy ─────────────────────────────────────────────────────────────────

export interface PushCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * One table: a fixed title and body per kind (new-work per tab). A push
 * carries no business data — no SKU, no quantity, no warehouse name; the
 * inbox is the source of truth.
 */
export const PUSH_COPY = {
  'new-work': {
    Pick: { title: 'New work ready', body: 'Picks released in your warehouse' },
    Count: { title: 'New work ready', body: 'A count was created' },
    Transfer: { title: 'New work ready', body: 'An inbound transfer is on its way' },
  },
  approval: { title: 'Approval waiting', body: 'Decide it on the web' },
  'at-risk': { title: 'Wave cutoff in under an hour', body: "A planned wave isn't released yet" },
} as const satisfies {
  readonly 'new-work': Readonly<Record<Exclude<PushTab, 'All'>, PushCopy>>;
  readonly approval: PushCopy;
  readonly 'at-risk': PushCopy;
};

/** The copy for a row; null for a combination no enqueue ever writes (new-work on `All`). */
export function pushCopyFor(kind: PushKind, tab: PushTab): PushCopy | null {
  if (kind === 'new-work') return tab === 'All' ? null : PUSH_COPY['new-work'][tab];
  return PUSH_COPY[kind];
}

// ── the audience ────────────────────────────────────────────────────────────

/** What a kind's audience check needs beyond the role. */
export interface PushAudienceFacts {
  readonly kind: PushKind;
  /** new-work: the work's warehouse. */
  readonly warehouseId: string | null;
  /** approval: which 9-2 source. */
  readonly approvalSource: ApprovalPushSource | null;
}

/**
 * Whether a BASE-eligible target (tenancy's `PushTarget` — active device,
 * registered token, active non-client operator with a floor role or
 * `accountant`) is in a kind's audience:
 *  - **new-work** — a floor role, and the handheld registered to the work's
 *    warehouse;
 *  - **approval** — the role passes 9-2's `SOURCE_AUDIENCE` for that source
 *    (`visibleSourceTypes`, reused — never re-derived); any warehouse;
 *  - **at-risk** — the role holds `waves.manage`; any warehouse.
 * Checked twice: at enqueue and again at send.
 */
export function pushAudienceAllows(
  target: { readonly role: UserRole; readonly warehouseId: string | null },
  facts: PushAudienceFacts,
): boolean {
  switch (facts.kind) {
    case 'new-work':
      return isFloorRole(target.role) && facts.warehouseId !== null && target.warehouseId === facts.warehouseId;
    case 'approval':
      return facts.approvalSource !== null && visibleSourceTypes(target.role).includes(facts.approvalSource);
    case 'at-risk':
      return ROLE_CAPABILITIES[target.role]?.has('waves.manage') ?? false;
    default: {
      const exhaustive: never = facts.kind;
      throw new Error(`unknown push kind ${String(exhaustive)}`);
    }
  }
}

// Every approval source must be a 9-2 source with an audience (a module-load assertion — §4).
for (const source of APPROVAL_PUSH_SOURCES) {
  if (SOURCE_AUDIENCE[source] === undefined) {
    throw new Error(`approval push source ${source} has no 9-2 audience`);
  }
}

// ── the send outcome ────────────────────────────────────────────────────────

/**
 * How a send outcome is handled:
 *  - `permanent` — the row is `failed` with the code (`DeviceNotRegistered`
 *    also clears the device's token, compare-and-clear);
 *  - `transient` — back to `pending`, one more attempt, backoff; `failed`
 *    after `PUSH_MAX_ATTEMPTS`;
 *  - `config` — this deployment's credentials are wrong: logged at error once
 *    per tick, back to `pending` WITHOUT spending an attempt; `failed` once
 *    the row is older than `PUSH_CONFIG_FAULT_MAX_AGE_MS`.
 */
export type PushErrorClass = 'permanent' | 'transient' | 'config';

/**
 * The ONE classification table. Codes are Expo's ticket `details.error`
 * values, or the gateway's own whole-request codes (`network`, `timeout`,
 * `http-<status>`). A code not listed here — and any `http-4xx` not listed —
 * is `permanent` (an unknown failure is never retried blind); any
 * `http-5xx` is `transient` (`classifyPushCode`).
 */
export const PUSH_ERROR_CLASS: Readonly<Record<string, PushErrorClass>> = {
  DeviceNotRegistered: 'permanent',
  MessageTooBig: 'permanent',
  InvalidProviderToken: 'permanent',
  MessageRateExceeded: 'transient',
  network: 'transient',
  timeout: 'transient',
  'http-429': 'transient',
  'http-401': 'config',
  'http-403': 'config',
  InvalidCredentials: 'config',
};

export function classifyPushCode(code: string): PushErrorClass {
  const listed = PUSH_ERROR_CLASS[code];
  if (listed !== undefined) return listed;
  if (/^http-5\d\d$/.test(code)) return 'transient';
  return 'permanent';
}

/** A stored / logged error code: bounded, and never a message (Expo's messages contain the token). */
export function boundedCode(code: string): string {
  const safe = code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return safe.length === 0 ? 'unknown' : safe;
}
