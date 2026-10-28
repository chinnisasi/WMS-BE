import { isIP } from 'node:net';

/**
 * Story 5-2a — the client-webhooks module's vocabularies, timing, the URL
 * rules at save time, the outcome fate table and the retry schedule. Pure:
 * no database, no network, no env (the env lives in `webhook-config.ts`).
 *
 * Every tuple here is mirrored by a CHECK in `drizzle/0100_client_webhooks.sql`
 * and pinned against it by `test/client-webhooks.spec.ts` (§4's three layers).
 */

/** The public, subscribable event vocabulary (decision 3). */
export const WEBHOOK_EVENT_TYPES = ['receipt.recorded', 'order.dispatched'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The synchronous test send's envelope type — never stored, never subscribable (A4). */
export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';

/** The outbox events each public type is sourced from (decision 3). Nothing else feeds them. */
export const WEBHOOK_SOURCE_EVENTS = {
  'grn.recorded': 'receipt.recorded',
  'order.dispatched': 'order.dispatched',
} as const satisfies Record<string, WebhookEventType>;
export type WebhookSourceEvent = keyof typeof WEBHOOK_SOURCE_EVENTS;
export const WEBHOOK_SOURCE_EVENT_TYPES = Object.keys(WEBHOOK_SOURCE_EVENTS) as WebhookSourceEvent[];

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Why an endpoint is disabled: by staff (`manual`), by the sender after ten
 * final failures over 24 hours (`failing`), at once on a 410 (`gone`), or at
 * claim when its client has departed (`client-departed`).
 */
export const WEBHOOK_DISABLED_REASONS = ['manual', 'failing', 'gone', 'client-departed'] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];
/** The reasons that open a panel episode (`disabled_episode_id`) and raise `webhook_endpoint.disabled` (A10). */
export const WEBHOOK_EPISODE_REASONS = ['failing', 'gone'] as const satisfies readonly WebhookDisabledReason[];

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'sending', 'held', 'succeeded', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
export const WEBHOOK_FINAL_DELIVERY_STATUSES = ['succeeded', 'failed'] as const satisfies readonly WebhookDeliveryStatus[];

/** The bulk redeliver's filter: every failed delivery, or the `expired` ones only (A2). */
export const WEBHOOK_BULK_REDELIVER_STATUSES = ['failed', 'expired'] as const;
export type WebhookBulkRedeliverStatus = (typeof WEBHOOK_BULK_REDELIVER_STATUSES)[number];

/** The re-enable's choice for the held backlog (A5). */
export const WEBHOOK_HELD_DECISIONS = ['release', 'discard'] as const;
export type WebhookHeldDecision = (typeof WEBHOOK_HELD_DECISIONS)[number];

/**
 * The resolutions of a `webhook-disabled` panel entry (A10) — the
 * notifications source repeats this tuple as literals (AD-6) and the suite
 * pins the two equal.
 */
export const WEBHOOK_RESOLUTIONS = ['re-enabled', 'deleted', 'manually-disabled'] as const;

/** The outbox events this module emits (the notifications source reads them). */
export const WEBHOOK_DISABLED_EVENT = 'webhook_endpoint.disabled';
export const WEBHOOK_ENABLED_EVENT = 'webhook_endpoint.enabled';
export const WEBHOOK_DELETED_EVENT = 'webhook_endpoint.deleted';
export const WEBHOOK_MANUALLY_DISABLED_EVENT = 'webhook_endpoint.manually_disabled';

// ── limits ───────────────────────────────────────────────────────────────

/** Endpoints per client, counting every non-deleted one (decision 14). */
export const MAX_WEBHOOK_ENDPOINTS_PER_CLIENT = 5;
export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 200;
/** One limit for the builder and the 0100 `webhook_events_body_check` (A24). */
export const WEBHOOK_BODY_MAX_BYTES = 262_144;
/** The v1 envelope. A breaking change is v2; fields are added within v1, never renamed or removed. */
export const WEBHOOK_SCHEMA_VERSIONS = [1] as const;
export type WebhookSchemaVersion = (typeof WEBHOOK_SCHEMA_VERSIONS)[number];

// ── timing ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The retry waits after each failed attempt (A2): 1 m, 5 m, 30 m, 2 h, 6 h,
 * 12 h, 24 h, 24 h — nine attempts, the last about 68.6 h after the first,
 * inside the 72-hour expiry.
 */
export const WEBHOOK_RETRY_WAITS_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 24 * HOUR] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_WAITS_MS.length + 1;
/** A pending delivery older than this (on `pending_since`) fails `expired`. */
export const WEBHOOK_PENDING_EXPIRY_MS = 72 * HOUR;
/** A `sending` row older than this returns to `pending` (the worker died mid-send) — fixed, asserted at boot. */
export const WEBHOOK_STALE_MS = 300_000;
/** No new send starts past this much of a tick (A3); the claimed rest return to `pending`, no attempt spent. */
export const WEBHOOK_TICK_BUDGET_MS = 60_000;
/** At most this many `sending` rows per endpoint, across ticks and processes (A3). */
export const WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT = 2;
/** A `Retry-After` (429 / 503) is honoured up to this (A2). */
export const WEBHOOK_RETRY_AFTER_MAX_MS = 24 * HOUR;
/** An unopenable secret (a config fault) is retried after this, no attempt spent (A17). */
export const WEBHOOK_CONFIG_FAULT_RETRY_MS = MINUTE;
/** A rotation keeps the previous secret signing for this long (decision 10). */
export const WEBHOOK_PREVIOUS_SECRET_TTL_MS = 24 * HOUR;
/** Final deliveries, and events left with none, are purged after this many days (A2). */
export const WEBHOOK_RETENTION_DAYS = 30;
export const WEBHOOK_PURGE_BATCH = 1000;
/** A failing endpoint holds at most this many deliveries; past it the oldest fail `held-overflow` (A5). */
export const WEBHOOK_MAX_HELD_PER_ENDPOINT = 10_000;
/** A held delivery older than this fails `held-expired` (A5). */
export const WEBHOOK_HELD_MAX_AGE_DAYS = 30;
/** The auto-disable threshold: this many consecutive final failures… */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;
/** …spanning at least this long (A12). */
export const WEBHOOK_DISABLE_AFTER_MS = 24 * HOUR;
/** The quarantine reconcile reads outbox rows younger than this (A1). */
export const WEBHOOK_RECONCILE_WINDOW_MS = 72 * HOUR;
/** Single redeliver, bulk redeliver and test: at most this many a minute per endpoint (A20). */
export const WEBHOOK_MANUAL_SENDS_PER_MINUTE = 10;
/** A bulk redeliver resets at most this many deliveries, oldest first (A2). */
export const WEBHOOK_BULK_REDELIVER_MAX = 1000;
/** The receiver's replay window the docs and the panel state (decision 9). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
/** At most this much of a response is read, then the socket is destroyed (decision 11). */
export const WEBHOOK_RESPONSE_READ_BYTES = 4096;

/** The retry wait after the n-th failed attempt (1-based), before jitter. */
export function webhookRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), WEBHOOK_RETRY_WAITS_MS.length) - 1;
  return WEBHOOK_RETRY_WAITS_MS[index]!;
}

/**
 * The wait actually used: 0 to −10 % jitter (never later, so the schedule
 * stays inside the expiry), replaced by a longer `Retry-After` up to 24 h.
 */
export function webhookNextWaitMs(attempts: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = webhookRetryDelayMs(attempts);
  const jittered = Math.round(base * (1 - 0.1 * Math.min(Math.max(random(), 0), 1)));
  if (retryAfterMs !== null && retryAfterMs > jittered) return Math.min(retryAfterMs, WEBHOOK_RETRY_AFTER_MAX_MS);
  return jittered;
}

/** A `Retry-After` header value (delta-seconds or an HTTP date) → ms from `now`, or null. */
export function parseRetryAfterMs(raw: string | undefined, now: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

// ── the outcome fate table (A18) ─────────────────────────────────────────

/**
 * The transport's own failure codes (never a message, never an address):
 * `network` (no connection, or reset), `timeout`, `dns-failed`,
 * `tls-handshake`, `tls-cert` (an invalid or mismatched certificate) and
 * `target-blocked` (the SSRF guard refused every resolved address, or the
 * socket connected somewhere it was not sent).
 */
export const WEBHOOK_TRANSPORT_CODES = ['network', 'timeout', 'dns-failed', 'tls-handshake', 'tls-cert', 'target-blocked'] as const;
export type WebhookTransportCode = (typeof WEBHOOK_TRANSPORT_CODES)[number];

/**
 * The codes the module writes itself on a final or held row:
 * `stale` (a `sending` row past five minutes, returned to `pending`),
 * `expired` (not delivered within 72 h of `pending_since`),
 * `secret-unavailable` (the signing secret did not open — a config fault),
 * `endpoint-disabled` / `endpoint-deleted` / `unsubscribed` /
 * `client-departed` (the endpoint changed since enqueue), `held-overflow` /
 * `held-expired` / `discarded` (the held backlog).
 */
export const WEBHOOK_LOCAL_CODES = [
  'stale',
  'expired',
  'secret-unavailable',
  'endpoint-disabled',
  'endpoint-deleted',
  'unsubscribed',
  'client-departed',
  'held-overflow',
  'held-expired',
  'discarded',
] as const;

/** What a send's outcome does to the delivery. */
export type WebhookFate =
  /** 2xx: `succeeded`; the endpoint's counters reset. */
  | { readonly kind: 'succeeded' }
  /** Retried on the A2 schedule; final on the 9th attempt — counted toward auto-disable when final. */
  | { readonly kind: 'retry'; readonly countsWhenFinal: boolean }
  /** `failed` at once, counted toward auto-disable. */
  | { readonly kind: 'failed' }
  /** 410: `failed http-410` and the endpoint auto-disabled at once, reason `gone`. */
  | { readonly kind: 'gone' };

/** One send's outcome as the transport reports it. */
export type WebhookSendOutcome =
  | { readonly kind: 'response'; readonly statusCode: number; readonly retryAfterMs: number | null; readonly durationMs: number }
  | { readonly kind: 'error'; readonly code: WebhookTransportCode; readonly durationMs: number };

/** The A18 table. */
export function classifyOutcome(outcome: WebhookSendOutcome): WebhookFate {
  if (outcome.kind === 'error') {
    // target-blocked retries but never counts: a receiver's DNS pointing at
    // a private address is our refusal, not their failure.
    return { kind: 'retry', countsWhenFinal: outcome.code !== 'target-blocked' };
  }
  const status = outcome.statusCode;
  if (status >= 200 && status <= 299) return { kind: 'succeeded' };
  if (status === 410) return { kind: 'gone' };
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return { kind: 'retry', countsWhenFinal: true };
  // 1xx (never final in practice), 3xx (a redirect is never followed), and
  // every other 4xx: permanent — the receiver refused the request itself.
  return { kind: 'failed' };
}

/** The stored error code of an outcome (`http-<status>` for a non-2xx response). */
export function outcomeErrorCode(outcome: WebhookSendOutcome): string | null {
  if (outcome.kind === 'error') return outcome.code;
  return outcome.statusCode >= 200 && outcome.statusCode <= 299 ? null : `http-${outcome.statusCode}`;
}

/** The stored status code of an outcome (null when no response came back). */
export function outcomeStatusCode(outcome: WebhookSendOutcome): number | null {
  return outcome.kind === 'response' && outcome.statusCode >= 100 && outcome.statusCode <= 599 ? outcome.statusCode : null;
}

/** The A12 predicate: auto-disable an ACTIVE endpoint once it has failed enough, for long enough. */
export function shouldAutoDisable(consecutiveFailures: number, failingSince: string | null, now: number): boolean {
  if (failingSince === null || consecutiveFailures < WEBHOOK_DISABLE_AFTER_FAILURES) return false;
  return now - Date.parse(failingSince) >= WEBHOOK_DISABLE_AFTER_MS;
}

// ── URL rules at save (decision 11 as amended by A14) ────────────────────

/** A save-time refusal, naming the rule (rendered as 400 `validation-failed`). */
export class WebhookUrlError extends Error {
  constructor(readonly rule: 'parse' | 'scheme' | 'userinfo' | 'fragment' | 'host' | 'port' | 'length', detail: string) {
    super(detail);
    this.name = 'WebhookUrlError';
  }
}

/** Host suffixes that only ever name a private network. */
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'] as const;
/** A label of a DNS name: letters, digits, hyphens, not starting or ending with a hyphen. */
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A host that WHATWG may read as a number: all digits, hex, octal, or dotted numerics (`127.1`, `0x7f.1`). */
const NUMERIC_HOST_RE = /^(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+))*\.?$/i;

/**
 * Normalises a webhook URL, or throws `WebhookUrlError` naming the rule:
 * WHATWG-parsed; `https:` only; no userinfo and no fragment; the host a DNS
 * name with a dot — not an IP literal (any spelling), not `localhost`, not
 * under `.local`, `.localhost`, `.internal` or `.home.arpa`, and not one of
 * `denyHosts` (the deployment's own hostnames); port 443 or 1024–65535; at
 * most 2048 characters. One trailing dot is stripped; the host is
 * lower-cased; the default port is dropped.
 */
export function normaliseWebhookUrl(raw: string, denyHosts: readonly string[] = []): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > WEBHOOK_URL_MAX_LENGTH) {
    throw new WebhookUrlError('length', `url must be 1 to ${WEBHOOK_URL_MAX_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebhookUrlError('parse', 'url must be an absolute URL such as https://hooks.example.com/wms.');
  }
  if (url.protocol !== 'https:') {
    throw new WebhookUrlError('scheme', 'url must use https — plain http is never sent.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebhookUrlError('userinfo', 'url must not carry a user name or password — authenticate with the signature instead.');
  }
  if (url.hash !== '' || trimmed.includes('#')) {
    throw new WebhookUrlError('fragment', 'url must not carry a #fragment.');
  }
  // The raw host before WHATWG's IPv4 rewriting: `https://2130706433/` parses
  // to 127.0.0.1, so the numeric shape is judged on what the user typed too.
  const typedHost = typedHostOf(trimmed);
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || isIP(host) !== 0 || NUMERIC_HOST_RE.test(host) || (typedHost !== null && NUMERIC_HOST_RE.test(typedHost))) {
    throw new WebhookUrlError('host', 'url host must be a DNS name, not an IP address.');
  }
  if (!host.includes('.') || host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new WebhookUrlError('host', `url host "${host}" is not a public DNS name (localhost, .local, .localhost, .internal and .home.arpa are refused).`);
  }
  if (!host.split('.').every((label) => LABEL_RE.test(label))) {
    throw new WebhookUrlError('host', `url host "${host}" is not a valid DNS name.`);
  }
  if (isDeniedHost(host, denyHosts)) {
    throw new WebhookUrlError('host', `url host "${host}" belongs to this deployment and cannot receive webhooks.`);
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (port !== 443 && (port < 1024 || port > 65535)) {
    throw new WebhookUrlError('port', 'url port must be 443 or 1024–65535.');
  }
  const normalised = `https://${host}${port === 443 ? '' : `:${port}`}${url.pathname}${url.search}`;
  if (normalised.length > WEBHOOK_URL_MAX_LENGTH) {
    throw new WebhookUrlError('length', `url must be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`);
  }
  return normalised;
}

/** The host exactly as typed (between `//` and the next `/`, `?`, `#` or `:`), lower-cased; null when absent. */
function typedHostOf(raw: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(raw);
  return match === null ? null : match[1]!.toLowerCase();
}

/** A host on the deny list, or under one of its entries (`api.wms.example` denies `x.api.wms.example`). */
export function isDeniedHost(host: string, denyHosts: readonly string[]): boolean {
  const bare = host.toLowerCase().replace(/\.$/, '');
  return denyHosts.some((denied) => bare === denied || bare.endsWith(`.${denied}`));
}

/** The URL's host, for logs and the panel summary (never the path or query). */
export function webhookHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-host';
  }
}

/** The URL without its query string (A26): audit `changes` never store a receiver token. */
export function webhookUrlWithoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search === '' ? '' : '?…'}`;
  } catch {
    return 'invalid-url';
  }
}

/** Event types sorted into the tuple's order, duplicates removed (the fingerprint and the stored order). */
export function sortEventTypes(types: readonly WebhookEventType[]): WebhookEventType[] {
  return WEBHOOK_EVENT_TYPES.filter((type) => types.includes(type));
}

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** The boot assert on the stale bound (A3): ≥ 2 × the HTTP timeout and > the tick budget. */
export function assertStaleBound(httpTimeoutMs: number): void {
  if (WEBHOOK_STALE_MS < 2 * httpTimeoutMs || WEBHOOK_STALE_MS <= WEBHOOK_TICK_BUDGET_MS) {
    throw new Error(
      `WEBHOOK_HTTP_TIMEOUT_MS=${httpTimeoutMs} is too long: the stale bound (${WEBHOOK_STALE_MS} ms) must be at least twice the HTTP timeout and longer than the ${WEBHOOK_TICK_BUDGET_MS} ms tick budget.`,
    );
  }
}
