import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { emailMessages } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { acceptInviteLinkFrom } from './links';
import { addressAllowed, mailConfigFromEnv } from './mail.config';
import { sealEmailSecret } from './mail-secrets';
import { MailSender, type MailSendSummary, type SendDueOptions } from './mail.sender';
import {
  EMAIL_LIVE_STATUSES,
  EMAIL_TEMPLATE_PRIORITY,
  type ClientEmailTemplate,
  type EmailAttachmentKind,
  type EmailStatus,
  type EmailTemplate,
} from './mail-rules';
import type {
  ClientDispatchEmailParams,
  ClientReceiptEmailParams,
  InviteEmailParams,
  PasswordChangedEmailParams,
  PasswordResetEmailParams,
} from './templates';

// Story 2-9a — the send-time attachment port: a domain module registers its
// renderer on the registry (`client-emails` → the GRN PDF). Re-exported here,
// the only seam other modules import.
export { MailAttachmentRegistry } from './mail-attachments';
export type { EmailAttachment, EmailAttachmentRenderer } from './mail-attachments';
export { EMAIL_ATTACHMENT_KINDS, type EmailAttachmentKind } from './mail-rules';

/**
 * Story 5-1a — the mail module's ONLY seam (`test/architecture.spec.ts`:
 * other modules import `mail.facade` and nothing else under
 * `src/modules/mail`; the mail module imports nothing from tenancy).
 *
 * Two kinds of entry:
 *  - **free functions over the caller's transaction** — `queueEmailInTx`
 *    (the ONLY writer of a new `email_messages` row), `cancelUserEmailsInTx`
 *    and `latestUserEmailsInTx`. A business command calls them inside its
 *    own transaction, so a rolled-back command queues nothing and a replay
 *    (which returns before any write) queues nothing;
 *  - **`MailFacade`** — the jobs shell's `EmailSenderWorker` drives
 *    `sendDue(tenantId)` per tenant.
 */

export {
  EMAIL_STATUSES,
  EMAIL_SENDING_STALE_MS,
  EMAIL_PENDING_EXPIRY_MS,
  EMAIL_RETENTION_DAYS,
  EMAIL_FINAL_STATUSES,
  EMAIL_PRIORITY_RESERVE,
  CLIENT_EMAIL_TEMPLATES,
} from './mail-rules';
export type { ClientEmailTemplate, EmailStatus, EmailTemplate } from './mail-rules';
export type {
  ClientDispatchEmailParams,
  ClientDispatchLineParams,
  ClientReceiptEmailParams,
  ClientReceiptLineParams,
  InviteEmailParams,
  PasswordChangedEmailParams,
  PasswordResetEmailParams,
} from './templates';
export { CLIENT_EMAIL_MAX_LINES } from './templates';
export type { MailSendSummary, SendDueOptions } from './mail.sender';

/**
 * What a command passes to queue one message — a union over the templates
 * (story 6-1c), so each template's parameters are checked where they are
 * queued.
 */
export type QueueEmailInput = {
  readonly tenantId: string;
  readonly to: string;
  /** The secret the message needs only at send time — sealed in the row, wiped once final. Never stored in `params`. */
  readonly secret?: string;
  /** What the message concerns: the users list reads the latest invite per user. */
  readonly sourceRef: { readonly userId: string | null };
} & (
  | { readonly template: 'user-invite'; readonly params: InviteEmailParams }
  | { readonly template: 'password-reset'; readonly params: PasswordResetEmailParams }
  | { readonly template: 'password-changed'; readonly params: PasswordChangedEmailParams }
);

export interface QueuedEmail {
  readonly id: string;
  /** `pending`, or `skipped` (provider off, or an address outside the allowlist). */
  readonly status: Extract<EmailStatus, 'pending' | 'skipped'>;
}

/**
 * Queues one message IN THE CALLER'S TRANSACTION. Provider `off`, or an
 * address outside `EMAIL_ALLOWLIST_DOMAINS`, writes the row `skipped` (with
 * no secret); otherwise `pending`, due now, with the secret sealed under
 * `EMAIL_SEAL_KEY` for exactly this row (AAD `tenant_id:id`).
 */
export async function queueEmailInTx(tx: TenantTx, input: QueueEmailInput): Promise<QueuedEmail> {
  const config = mailConfigFromEnv();
  const id = uuidv7();
  const skipCode = config.provider === 'off' ? 'provider-off' : addressAllowed(config, input.to) ? null : 'allowlist';
  const status = skipCode === null ? 'pending' : 'skipped';
  const sealedSecret =
    status === 'pending' && input.secret !== undefined ? sealEmailSecret(input.secret, input.tenantId, id) : null;
  await tx.insert(emailMessages).values({
    id,
    tenantId: input.tenantId,
    userId: input.sourceRef.userId,
    template: input.template,
    toEmail: input.to,
    params: input.params,
    sealedSecret,
    status,
    nextAttemptAt: sql`now()`,
    errorCode: skipCode,
  });
  return { id, status };
}

/**
 * Story 5-2b — what the `client-emails` subscriber passes to queue one
 * client notice. A separate writer (and input type) from `queueEmailInTx`,
 * whose signature and bytes are unchanged: a client notice carries no secret
 * and no user, but a client and a dedupe key.
 */
export type QueueClientEmailInput = {
  readonly tenantId: string;
  readonly clientId: string;
  readonly to: string;
  /** `{template}:{subjectId}:{email}` — unique per tenant: a re-delivered event queues nothing new. */
  readonly dedupeKey: string;
} & (
  | {
      readonly template: 'client-receipt';
      readonly params: ClientReceiptEmailParams;
      /**
       * Story 2-9a (decision 17) — a file the sender renders at SEND time
       * (`grn-pdf` with the GRN id). Omitted, the row's attachment columns
       * are NULL — every 5-2b caller and row unchanged.
       */
      readonly attachment?: { readonly kind: EmailAttachmentKind; readonly ref: string };
    }
  | { readonly template: 'client-dispatch'; readonly params: ClientDispatchEmailParams }
);

/**
 * Story 5-2b — queues one client notice IN THE CALLER'S TRANSACTION, with
 * the same provider-off and allowlist skip as `queueEmailInTx` (a skipped row
 * is still written, so the log shows it), priority 1 (claimed after account
 * mail), no secret. The insert is `ON CONFLICT DO NOTHING` on
 * `email_messages_dedupe_unique`: null means the row already exists (a
 * re-delivered event, an operator replay) — nothing new was queued. Makes no
 * network call (pinned by `test/architecture.spec.ts`).
 */
export async function queueClientEmailInTx(tx: TenantTx, input: QueueClientEmailInput): Promise<QueuedEmail | null> {
  const config = mailConfigFromEnv();
  const id = uuidv7();
  const skipCode = config.provider === 'off' ? 'provider-off' : addressAllowed(config, input.to) ? null : 'allowlist';
  const status = skipCode === null ? 'pending' : 'skipped';
  const inserted = await tx
    .insert(emailMessages)
    .values({
      id,
      tenantId: input.tenantId,
      userId: null,
      clientId: input.clientId,
      dedupeKey: input.dedupeKey,
      priority: EMAIL_TEMPLATE_PRIORITY[input.template],
      template: input.template,
      toEmail: input.to,
      params: input.params,
      sealedSecret: null,
      status,
      nextAttemptAt: sql`now()`,
      errorCode: skipCode,
      attachmentKind: input.template === 'client-receipt' ? (input.attachment?.kind ?? null) : null,
      attachmentRef: input.template === 'client-receipt' ? (input.attachment?.ref ?? null) : null,
    })
    .onConflictDoNothing({ target: [emailMessages.tenantId, emailMessages.dedupeKey], where: sql`dedupe_key IS NOT NULL` })
    .returning({ id: emailMessages.id });
  return inserted.length === 0 ? null : { id, status };
}

/**
 * Story 5-2b — cancels every still-QUEUED (`pending`) client notice of
 * `templates` to `email` for one client (`unsubscribed`): its contact was
 * removed, changed its address, or dropped the event. A `sending` row is
 * left alone — it may already be with the provider, so it reports its real
 * outcome rather than reading "Cancelled". Returns how many it cancelled.
 */
export async function cancelClientEmailsToInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  email: string,
  templates: readonly ClientEmailTemplate[],
  reason: 'unsubscribed',
): Promise<number> {
  if (templates.length === 0) return 0;
  const cancelled = await tx
    .update(emailMessages)
    .set({ status: 'cancelled', sealedSecret: null, errorCode: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.clientId, clientId),
        eq(emailMessages.toEmail, email),
        inArray(emailMessages.template, [...templates]),
        eq(emailMessages.status, 'pending'),
      ),
    )
    .returning({ id: emailMessages.id });
  return cancelled.length;
}

/** Story 5-2b — one row of a client's email log (newest first). */
export interface ClientEmailLogRow {
  readonly id: string;
  readonly template: ClientEmailTemplate;
  /** The GRN code or the order reference, read from the stored params (no join). */
  readonly subjectLabel: string;
  readonly to: string;
  readonly status: EmailStatus;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The raw, full-precision `created_at` — the keyset cursor's instant. */
  readonly cursorAt: string;
}

/** A row the log calls a problem: not sent, or refused by the staging allowlist. */
export const CLIENT_EMAIL_PROBLEM_SQL = sql`(${emailMessages.status} in ('failed', 'expired') or (${emailMessages.status} = 'skipped' and ${emailMessages.errorCode} = 'allowlist'))`;

function subjectLabelOf(template: string, params: unknown): string {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const label = template === 'client-receipt' ? value.grnCode : value.orderRef;
  return typeof label === 'string' && label !== '' ? label : '—';
}

/**
 * Story 5-2b — a client's notices, newest first, keyset on
 * `(created_at, id)` (`email_messages_client_created_idx`); `limit + 1` rows
 * are read so the caller knows whether a next page exists.
 */
export async function listClientEmailsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly problems: boolean; readonly after: { readonly createdAt: string; readonly id: string } | null; readonly limit: number },
): Promise<ClientEmailLogRow[]> {
  const rows = await tx
    .select({
      id: emailMessages.id,
      template: emailMessages.template,
      params: emailMessages.params,
      toEmail: emailMessages.toEmail,
      status: emailMessages.status,
      errorCode: emailMessages.errorCode,
      attempts: emailMessages.attempts,
      createdAt: emailMessages.createdAt,
      updatedAt: emailMessages.updatedAt,
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.clientId, clientId),
        query.problems ? CLIENT_EMAIL_PROBLEM_SQL : undefined,
        query.after === null
          ? undefined
          : sql`(${emailMessages.createdAt}, ${emailMessages.id}) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      ),
    )
    .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
    .limit(query.limit + 1);
  return rows.map((row) => ({
    id: row.id,
    template: row.template as ClientEmailTemplate,
    subjectLabel: subjectLabelOf(row.template, row.params),
    to: row.toEmail,
    status: row.status as EmailStatus,
    errorCode: row.errorCode,
    attempts: row.attempts,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
    cursorAt: fullPrecisionInstant(row.createdAt),
  }));
}

/** Story 5-2b — the latest client notice to one address (the contact badge). */
export interface LatestClientEmail {
  readonly status: EmailStatus;
  readonly errorCode: string | null;
  readonly at: string;
}

/**
 * Story 5-2b (A8) — for each address, the LATEST client notice of this
 * client to it (`DISTINCT ON (to_email)` by `created_at DESC, id DESC`, on
 * `email_messages_client_address_idx`). An address with none is absent.
 */
export async function latestClientEmailsByAddressInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  emails: readonly string[],
): Promise<Map<string, LatestClientEmail>> {
  const distinct = [...new Set(emails)];
  if (distinct.length === 0) return new Map();
  const rows = await latestClientEmailsQuery(tx, tenantId, clientId, distinct);
  return new Map(
    rows.map((row) => [row.toEmail, { status: row.status as EmailStatus, errorCode: row.errorCode, at: canonicalInstant(row.updatedAt) }]),
  );
}

/** The badge read itself — exported so the suite EXPLAINs the REAL query (A8). */
export function latestClientEmailsQuery(tx: TenantTx, tenantId: string, clientId: string, emails: readonly string[]) {
  return tx
    .selectDistinctOn([emailMessages.toEmail], {
      toEmail: emailMessages.toEmail,
      status: emailMessages.status,
      errorCode: emailMessages.errorCode,
      updatedAt: emailMessages.updatedAt,
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.clientId, clientId),
        sql`${emailMessages.toEmail} = any(${sql.param([...emails])}::text[])`,
      ),
    )
    .orderBy(emailMessages.toEmail, desc(emailMessages.createdAt), desc(emailMessages.id));
}

/**
 * Story 5-2b (A5) — how many client notices of each template this client
 * has had queued since IST midnight, ANY status — on the DATABASE clock
 * (never the JS clock), on `email_messages_client_created_idx`. The daily
 * cap and the log's `capReachedToday` read the same count.
 */
export async function clientEmailCountsTodayInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<Record<ClientEmailTemplate, number>> {
  const rows = (await tx.execute(sql`
    select template, count(*)::int as n
      from email_messages
     where tenant_id = ${tenantId}::uuid
       and client_id = ${clientId}::uuid
       and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
     group by template
  `)) as unknown as { template: string; n: number }[];
  const count = (template: ClientEmailTemplate) => Number(rows.find((row) => row.template === template)?.n ?? 0);
  return { 'client-receipt': count('client-receipt'), 'client-dispatch': count('client-dispatch') };
}

/** Story 5-2b (D9) — `EMAIL_PROVIDER ≠ off`: is mail sent (or logged) on this server at all? */
export function mailProviderEnabled(): boolean {
  try {
    return mailConfigFromEnv().provider !== 'off';
  } catch {
    return false;
  }
}

/**
 * Cancels every live (`pending` / `sending`) message of `template` for a
 * user, wiping each secret: a newer invite token supersedes the old link
 * (`superseded`), the user was deactivated (`deactivated`), or the invite was
 * accepted — its token spent (`accepted`). A `sending`
 * row may already be on its way — the sender's outcome write touches only
 * rows still `sending`, so the cancel stands. Returns how many it cancelled.
 */
export async function cancelUserEmailsInTx(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  template: EmailTemplate,
  reason: 'superseded' | 'deactivated' | 'accepted',
): Promise<number> {
  const cancelled = await tx
    .update(emailMessages)
    .set({ status: 'cancelled', sealedSecret: null, errorCode: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.userId, userId),
        eq(emailMessages.template, template),
        inArray(emailMessages.status, [...EMAIL_LIVE_STATUSES]),
      ),
    )
    .returning({ id: emailMessages.id });
  return cancelled.length;
}

/**
 * Story 6-1c (A4) — cancels the named live messages (a reset token spent by a
 * newer request: its mail must not deliver a dead link), wiping each secret.
 * Rows already final are left as they are. Returns how many it cancelled.
 */
export async function cancelEmailMessagesInTx(
  tx: TenantTx,
  tenantId: string,
  messageIds: readonly string[],
  reason: 'superseded',
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const cancelled = await tx
    .update(emailMessages)
    .set({ status: 'cancelled', sealedSecret: null, errorCode: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        inArray(emailMessages.id, [...messageIds]),
        inArray(emailMessages.status, [...EMAIL_LIVE_STATUSES]),
      ),
    )
    .returning({ id: emailMessages.id });
  return cancelled.length;
}

/** The latest message of `template` per user — the users list's `inviteEmail`. */
export interface LatestUserEmail {
  readonly status: EmailStatus;
  readonly updatedAt: string;
}

/**
 * For each user id, its LATEST message of `template` (by `created_at`, then
 * id) — one indexed read (`email_messages_tenant_user_created_idx`). A user
 * with none is absent.
 */
export async function latestUserEmailsInTx(
  tx: TenantTx,
  tenantId: string,
  userIds: readonly string[],
  template: EmailTemplate,
): Promise<Map<string, LatestUserEmail>> {
  const distinct = [...new Set(userIds)];
  if (distinct.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([emailMessages.userId], {
      userId: emailMessages.userId,
      status: emailMessages.status,
      updatedAt: emailMessages.updatedAt,
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.template, template),
        inArray(emailMessages.userId, distinct),
      ),
    )
    .orderBy(emailMessages.userId, desc(emailMessages.createdAt), desc(emailMessages.id));
  return new Map(
    rows
      .filter((row): row is typeof row & { userId: string } => row.userId !== null)
      .map((row) => [row.userId, { status: row.status as EmailStatus, updatedAt: canonicalInstant(row.updatedAt) }]),
  );
}

/**
 * The accept-invite link a response carries — the same string the email
 * carries (decision 7): built from `WEB_BASE_URL`. Null when no base URL is
 * configured (possible only with `EMAIL_PROVIDER=off`): the web then builds
 * the link from its own origin.
 */
export function inviteAcceptUrl(tenantId: string, token: string): string | null {
  const { webBaseUrl } = mailConfigFromEnv();
  return webBaseUrl === null ? null : acceptInviteLinkFrom(webBaseUrl, tenantId, token);
}

/** The jobs shell's seam: one sender pass per tenant. */
@Injectable()
export class MailFacade {
  constructor(@Inject(MailSender) private readonly sender: MailSender) {}

  /** Messages sent per worker tick across every tenant (`EMAIL_MAX_PER_TICK`). */
  maxPerTick(): number {
    return mailConfigFromEnv().maxPerTick;
  }

  /**
   * Stale sweep, expiry, purge, then claim and send at most `limit` due
   * messages for the tenant — account mail first; with `priorityReserve`
   * (the worker's), up to that many account rows even past the limit.
   */
  sendDue(tenantId: string, limit?: number, options?: SendDueOptions): Promise<MailSendSummary> {
    return this.sender.sendDue(tenantId, limit, options);
  }
}
