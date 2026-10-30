/**
 * Story 5-1a — the mail module's vocabularies, timing and the one error
 * classification table. Pure: no database, no network, no env.
 */

/**
 * The code-defined templates (`templates/*.ts`). Mirrored by
 * `email_messages_template_check` (0089; story 6-1c re-added it in 0103 with
 * the reset link and the password-changed notice).
 */
export const EMAIL_TEMPLATES = [
  'user-invite',
  'password-reset',
  'password-changed',
  'client-receipt',
  'client-dispatch',
  'client-shipment-document',
  // Story 4-6a (A20) — a packed order waits for the brand's documents (0118).
  'client-documents-needed',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/**
 * Story 5-2b — the client notices: a receipt and a dispatch email to a client
 * brand's opted-in contacts, queued by the `client-emails` outbox subscriber
 * through `queueClientEmailInTx` (each row carries `client_id` and a
 * `dedupe_key` — the 0114 `email_messages_client_shape_check`).
 */
export const CLIENT_EMAIL_TEMPLATES = ['client-receipt', 'client-dispatch', 'client-shipment-document', 'client-documents-needed'] as const satisfies readonly EmailTemplate[];
export type ClientEmailTemplate = (typeof CLIENT_EMAIL_TEMPLATES)[number];

/**
 * Story 5-2b (A7, D3) — the claim order, stored per row in
 * `email_messages.priority` (0114 `email_messages_priority_check`): account
 * mail (an invite, a reset link, the password-changed notice) is 0 and is
 * claimed before any client notice (1) — a client's dispatch backlog must
 * never delay an invite or a reset link. Exhaustive over the templates.
 */
export const EMAIL_TEMPLATE_PRIORITY = {
  'user-invite': 0,
  'password-reset': 0,
  'password-changed': 0,
  'client-receipt': 1,
  'client-dispatch': 1,
  // Story 4-4a — a client notice: after account mail.
  'client-shipment-document': 1,
  // Story 4-6a (A5) — a client notice: after account mail.
  'client-documents-needed': 1,
} as const satisfies Record<EmailTemplate, 0 | 1>;

/**
 * Story 5-2b (A7, D7) — when the worker's shared tick budget is spent, each
 * tenant may still claim up to this many priority-0 (account) rows, so an
 * invite or a reset never waits behind another tenant's client backlog. The
 * WORKER passes it (`sendDue(t, limit, {priorityReserve})`); a bare
 * `sendDue(t, n)` keeps its meaning.
 */
export const EMAIL_PRIORITY_RESERVE = 5;

/**
 * The lifecycle (0089 `email_messages_status_check`):
 * `pending → sending → sent | failed`, plus `skipped` (provider off, or an
 * address outside the allowlist), `expired` (not sent within 24 h) and
 * `cancelled` (superseded by a newer invite token, or the user deactivated).
 */
export const EMAIL_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped', 'expired', 'cancelled'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** The statuses that may still hold a sealed secret (0089 `email_messages_secret_wipe_check`). */
export const EMAIL_LIVE_STATUSES = ['pending', 'sending'] as const satisfies readonly EmailStatus[];
/** Every status a row never leaves — purged after `EMAIL_RETENTION_DAYS`. */
export const EMAIL_FINAL_STATUSES = ['sent', 'failed', 'skipped', 'expired', 'cancelled'] as const satisfies readonly EmailStatus[];

/** `EMAIL_PROVIDER`: SES v2, the capturing log gateway, or nothing (rows `skipped`). */
export const EMAIL_PROVIDERS = ['ses', 'log', 'off'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/** A `sending` row older than this is `failed 'stale'` and never re-sent (at-most-once). */
export const EMAIL_SENDING_STALE_MS = 10 * 60 * 1000;
/** A `pending` row not sent within this is `expired` (the invite is stale news by then; resend exists). */
export const EMAIL_PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Every final row is purged after this many days (the `user.invited` audit row is the durable record). */
export const EMAIL_RETENTION_DAYS = 90;
/** At most this many rows are purged per tenant per pass (a backlog drains over ticks). */
export const EMAIL_PURGE_BATCH = 1000;
/** A transient failure is retried; the fifth attempt that fails is final. */
export const EMAIL_MAX_ATTEMPTS = 5;
/** A config fault spends no attempt; the row is retried after this (and expires after 24 h). */
export const EMAIL_CONFIG_FAULT_RETRY_MS = 60 * 1000;
/** `EMAIL_MAX_PER_TICK` default — sized under the SES sandbox rate (1/s) at a multi-second poll. */
export const DEFAULT_EMAIL_MAX_PER_TICK = 10;

/** Backoff after the n-th failed attempt: min(2^(n−1)·30 s, 30 min). */
export function emailBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(2 ** exponent * 30_000, 30 * 60 * 1000);
}

/**
 * The codes the SENDER writes itself, never a provider code:
 * `stale` (a `sending` row past 10 minutes, or a send whose outcome is
 * unknown — a timeout after the request left), `unsealable` (the secret no
 * longer opens: the key rotated out), `render` (the stored parameters no
 * longer render), `superseded` / `deactivated` / `accepted` / `unsubscribed`
 * (a cancel), `allowlist` / `provider-off` (a skip).
 */
export const EMAIL_LOCAL_CODES = [
  'stale',
  'expired',
  'unsealable',
  'render',
  'superseded',
  'deactivated',
  'accepted',
  'allowlist',
  'provider-off',
  // Story 5-2b — a client email's contact was removed, changed its address or
  // dropped the event while the row was still queued.
  'unsubscribed',
  // Story 2-9a — the send-time attachment: its render threw (transient — the
  // last allowed attempt sends without the file, A14); no renderer is
  // registered for its kind (config — a deployment fault); the call's render
  // budget ran out before this row (released, no attempt spent — D7).
  'attachment-failed',
  'attachment-unavailable',
  'attachment-deferred',
] as const;

export type EmailErrorClass = 'transient' | 'config' | 'permanent' | 'unknown-outcome';

/**
 * The one classification table (decision 5). Codes are the SES v2 error
 * names, or the gateway's own: `network` (no connection was made — nothing
 * left), `timeout` (the request may have left — the outcome is unknown),
 * `address-not-verified` (the SES sandbox refusing an unverified recipient),
 * `suppressed` (the account suppression list holds the address).
 */
export const EMAIL_ERROR_CLASS: Readonly<Record<string, EmailErrorClass>> = {
  // transient — retried with backoff, at most 5 attempts
  TooManyRequestsException: 'transient',
  InternalServiceErrorException: 'transient',
  InternalServiceError: 'transient',
  ThrottlingException: 'transient',
  ServiceUnavailable: 'transient',
  network: 'transient',
  // Story 2-9a — the send-time render of an attachment threw.
  'attachment-failed': 'transient',
  // config — the deployment is wrong: no attempt spent, logged once per tick, pending until expiry
  // Story 2-9a — no renderer registered for the row's attachment kind.
  'attachment-unavailable': 'config',
  // The daily sending quota: retrying with backoff would fail every queued
  // message within minutes — it waits (no attempt spent) until the quota resets or expiry.
  LimitExceededException: 'config',
  AccountSuspendedException: 'config',
  SendingPausedException: 'config',
  MailFromDomainNotVerifiedException: 'config',
  NotFoundException: 'config',
  AccessDeniedException: 'config',
  AccessDenied: 'config',
  UnrecognizedClientException: 'config',
  InvalidClientTokenId: 'config',
  InvalidSignatureException: 'config',
  SignatureDoesNotMatch: 'config',
  ExpiredTokenException: 'config',
  MissingAuthenticationTokenException: 'config',
  CredentialsProviderError: 'config',
  'address-not-verified': 'config',
  // permanent — failed with the code
  BadRequestException: 'permanent',
  MessageRejected: 'permanent',
  suppressed: 'permanent',
  // unknown outcome — counted as stale: never re-sent (SES has no idempotency key)
  timeout: 'unknown-outcome',
};

/** The table, then `http-429` / `http-5xx` → transient, else permanent: an unknown failure is never retried blind. */
export function classifyEmailCode(code: string): EmailErrorClass {
  const listed = EMAIL_ERROR_CLASS[code];
  if (listed !== undefined) return listed;
  if (code === 'http-429' || /^http-5\d\d$/.test(code)) return 'transient';
  return 'permanent';
}

/** Only codes reach a column or a log line: `[A-Za-z0-9_.-]`, at most 64 characters. */
export function boundedEmailCode(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return cleaned === '' ? 'unknown-error' : cleaned;
}

/**
 * Story 2-9a (decision 17) — the files a client notice may carry, rendered at
 * SEND time by the renderer a domain module registered for the kind
 * (`MailAttachmentRegistry`). Mirrored by 0115
 * `email_messages_attachment_kind_check` (pinned by test/mail.spec.ts).
 * 4-4a (0116) added `stored-file`; 4-5a (0117, A4) adds `packing-slip-pdf`
 * (the dispatch email's packing slip, paired with `client-dispatch`).
 */
export const EMAIL_ATTACHMENT_KINDS = ['grn-pdf', 'stored-file', 'packing-slip-pdf'] as const;
export type EmailAttachmentKind = (typeof EMAIL_ATTACHMENT_KINDS)[number];

/** Above this an email is sent WITHOUT its file (the body says so — A16). The sender's default; a test lowers it. */
export const EMAIL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** One render's statement timeout (A15). */
export const EMAIL_ATTACHMENT_STATEMENT_TIMEOUT = '15s';
/** All renders of one `sendDue` call share this budget; past it the remaining rows are released (A15, D7). */
export const EMAIL_ATTACHMENT_RENDER_BUDGET_MS = 60_000;
