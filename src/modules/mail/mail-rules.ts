/**
 * Story 5-1a — the mail module's vocabularies, timing and the one error
 * classification table. Pure: no database, no network, no env.
 */

/**
 * The code-defined templates (`templates/*.ts`). Mirrored by
 * `email_messages_template_check` (0089; story 6-1c re-added it in 0103 with
 * the reset link and the password-changed notice).
 */
export const EMAIL_TEMPLATES = ['user-invite', 'password-reset', 'password-changed'] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

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
 * longer render), `superseded` / `deactivated` / `accepted` (a cancel), `allowlist` /
 * `provider-off` (a skip).
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
  // config — the deployment is wrong: no attempt spent, logged once per tick, pending until expiry
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
