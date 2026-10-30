/**
 * Story 5-2b — the client-emails module's rules. Pure: no database, no
 * network; the one environment read is `clientEmailEnabled`.
 */

/** The outbox events this module emails about, and the contact email event (`CLIENT_EMAIL_EVENTS`) each one is. */
export const CLIENT_EMAIL_SOURCE_EVENTS = {
  'grn.recorded': 'receipt.recorded',
  'order.dispatched': 'order.dispatched',
  // Story 4-4a (D6) — a shared shipping document or signed-sheet page.
  'shipment.document-shared': 'shipment.documents',
  // Story 4-6a (A20, A47) — a packed order still waiting for the brand's
  // documents (queued only when the gate read AT DELIVERY is blocking).
  'order.packed': 'consignment.documents-needed',
  // Story 4-9a (A27) — a freight consignment's delivery recorded (or amended).
  'freight_consignment.delivered': 'delivery.recorded',
} as const;
export type ClientEmailSourceEvent = keyof typeof CLIENT_EMAIL_SOURCE_EVENTS;
export const CLIENT_EMAIL_SOURCE_EVENT_TYPES = Object.keys(CLIENT_EMAIL_SOURCE_EVENTS) as ClientEmailSourceEvent[];

/**
 * Decision 9, A5 — at most this many client notices per (client, template)
 * per IST day, counted at enqueue over every row of the day in ANY status.
 * An event queues all of its recipients while the count is below it, else
 * none (all-or-nothing; one event may overshoot by at most 19). The D2C
 * guard until the daily digest (5-2d).
 */
export const CLIENT_EMAIL_DAILY_CAP = 500;

/**
 * An event APPENDED more than this long ago (its outbox row id's uuidv7 time
 * — never `occurredAt`, which can be device time) is acked without mail: a
 * deploy backlog, or an operator's replay days later. Far inside the 90-day
 * dedupe window, so a replay can never send twice.
 */
export const CLIENT_EMAIL_STALE_EVENT_MS = 24 * 60 * 60 * 1000;

/** The log read's page bounds. */
export const CLIENT_EMAIL_LOG_PAGE_DEFAULT = 50;
export const CLIENT_EMAIL_LOG_PAGE_MAX = 100;

/**
 * A4 — the kill switch, `CLIENT_EMAIL_ENABLED` (`true` | `false`, default
 * `false`). Off: the subscriber acks every event and writes nothing, and the
 * log read answers `clientMailEnabled: false` (opt-ins can still be edited).
 * Client mail goes to addresses staff typed in, on the shared SES account:
 * production enables it only once the SNS bounce/complaint intake ships (or
 * the risk is accepted in writing) — DEPLOY §2. Read per call, so a suite
 * flips it per test. Anything but `true` (any case, trimmed) is off.
 */
export function clientEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLIENT_EMAIL_ENABLED ?? '').trim().toLowerCase() === 'true';
}
