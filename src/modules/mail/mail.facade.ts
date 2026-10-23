import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { emailMessages } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import { acceptInviteLinkFrom } from './links';
import { addressAllowed, mailConfigFromEnv } from './mail.config';
import { sealEmailSecret } from './mail-secrets';
import { MailSender, type MailSendSummary } from './mail.sender';
import { EMAIL_LIVE_STATUSES, type EmailStatus, type EmailTemplate } from './mail-rules';
import type { InviteEmailParams } from './templates';

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

export { EMAIL_STATUSES, EMAIL_SENDING_STALE_MS, EMAIL_PENDING_EXPIRY_MS, EMAIL_RETENTION_DAYS, EMAIL_FINAL_STATUSES } from './mail-rules';
export type { EmailStatus, EmailTemplate } from './mail-rules';
export type { InviteEmailParams } from './templates';
export type { MailSendSummary } from './mail.sender';

/** What a command passes to queue one message. */
export type QueueEmailInput = {
  readonly tenantId: string;
  readonly to: string;
  /** The secret the message needs only at send time — sealed in the row, wiped once final. Never stored in `params`. */
  readonly secret?: string;
  /** What the message concerns: the users list reads the latest invite per user. */
  readonly sourceRef: { readonly userId: string | null };
} & { readonly template: 'user-invite'; readonly params: InviteEmailParams };

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

  /** Stale sweep, expiry, purge, then claim and send at most `limit` due messages for the tenant. */
  sendDue(tenantId: string, limit?: number): Promise<MailSendSummary> {
    return this.sender.sendDue(tenantId, limit);
  }
}
