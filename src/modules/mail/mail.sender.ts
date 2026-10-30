import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { emailMessages, type EmailMessageRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { EMAIL_GATEWAY, type EmailGateway, type EmailSendResult, type OutgoingEmail } from './email.gateway';
import { addressAllowed, mailConfigFromEnv } from './mail.config';
import { openEmailSecret } from './mail-secrets';
import { MailAttachmentRegistry, type EmailAttachment } from './mail-attachments';
import type { ClientReceiptAttachmentState } from './templates';
import {
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_ATTACHMENT_RENDER_BUDGET_MS,
  EMAIL_CONFIG_FAULT_RETRY_MS,
  EMAIL_FINAL_STATUSES,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_PENDING_EXPIRY_MS,
  EMAIL_PURGE_BATCH,
  EMAIL_RETENTION_DAYS,
  EMAIL_SENDING_STALE_MS,
  EMAIL_TEMPLATES,
  boundedEmailCode,
  classifyEmailCode,
  emailBackoffMs,
  type EmailTemplate,
} from './mail-rules';
import { renderEmail } from './templates';

/**
 * Story 2-9a (D6) — the sender's construction options (a test lowers the
 * bounds; production uses the defaults — no env variable, A16).
 */
export const MAIL_SENDER_OPTIONS = 'MAIL_SENDER_OPTIONS' as const;
export interface MailSenderOptions {
  /** Above this an attachment is not attached (the body says so). Default `EMAIL_ATTACHMENT_MAX_BYTES`. */
  readonly attachmentMaxBytes?: number;
  /** The render budget of one `sendDue` call. Default `EMAIL_ATTACHMENT_RENDER_BUDGET_MS`. */
  readonly renderBudgetMs?: number;
}

/** Story 5-2b (A7, D7) — the worker's per-call options. */
export interface SendDueOptions {
  /**
   * Priority-0 (account) rows this call may claim even when `limit` is spent
   * (`EMAIL_PRIORITY_RESERVE`, passed only by the worker): an invite or a
   * reset never waits behind another tenant's client backlog.
   */
  readonly priorityReserve?: number;
}

/**
 * Story 5-2b (A7) — the claim of one priority's due rows, oldest due first:
 * `(tenant_id, status, priority, next_attempt_at)` is
 * `email_messages_claim_idx`. Exported so the suite EXPLAINs the REAL query.
 */
export function dueClaimQuery(tx: TenantTx, tenantId: string, priority: 0 | 1, take: number) {
  return tx
    .select()
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.tenantId, tenantId),
        eq(emailMessages.status, 'pending'),
        eq(emailMessages.priority, priority),
        lte(emailMessages.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(emailMessages.nextAttemptAt), asc(emailMessages.createdAt), asc(emailMessages.id))
    .limit(take)
    .for('update', { skipLocked: true });
}

/** What one `sendDue` call did (the worker logs config codes; the suites assert the rest). */
export interface MailSendSummary {
  /** Rows claimed this call (≤ the limit, plus up to `priorityReserve` account rows past it — story 5-2b). */
  readonly claimed: number;
  /** Rows handed to the gateway. */
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly retried: number;
  readonly skipped: number;
  /** `sending` rows past 10 minutes, failed `stale` at the start of the call. */
  readonly stale: number;
  /** `pending` rows older than 24 hours, `expired` at the start of the call. */
  readonly expired: number;
  /** Final rows older than 90 days, deleted at the start of the call. */
  readonly purged: number;
  /** CONFIG-fault codes met (the deployment is wrong) — logged once per TICK by the worker, never here. */
  readonly configCodes: readonly string[];
}

interface Claimed {
  readonly row: EmailMessageRow;
  readonly email: OutgoingEmail;
}

const TEMPLATES: ReadonlySet<string> = new Set(EMAIL_TEMPLATES);
const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000}::double precision)`;

/**
 * Story 5-1a — the email SENDER, behind `MailFacade.sendDue` (driven per
 * tenant by the jobs shell's `EmailSenderWorker`; the push-sender pattern).
 * One call:
 *
 *  1. **Sweep and claim (tenant transaction A).** `sending` rows older than
 *     10 minutes → `failed 'stale'` (the process died mid-send — they may
 *     have gone out, so they are never re-sent: AT-MOST-ONCE, SES has no
 *     idempotency key). `pending` rows older than 24 hours → `expired`.
 *     Final rows older than 90 days are deleted (≤ 1,000 per call). Then up
 *     to `limit` due `pending` rows are taken `FOR UPDATE SKIP LOCKED` —
 *     account mail (priority 0) before client notices (priority 1, story
 *     5-2b), and up to the worker's `priorityReserve` account rows even when
 *     the limit is spent. Each
 *     is re-checked and rendered: provider `off` → `skipped`; an address now
 *     outside the allowlist → `skipped`; a secret that no longer opens →
 *     `failed 'unsealable'`; parameters that no longer render →
 *     `failed 'render'`. The rest become `sending`, and A COMMITS — before
 *     any provider call.
 *  2. **Send**, one message at a time, outside any transaction — each
 *     preceded by its own short transaction that re-checks the row is still
 *     `sending` (a cancel since the claim is honoured: never sent) and
 *     touches `updated_at` (a long batch's later rows never age stale).
 *  3. **Outcome**, written at once in its own short transaction, touching
 *     only a row still `sending` (a row cancelled or swept meanwhile is
 *     never resurrected; the counters move only on a matched row):
 *     ok → `sent` with the provider's message id; transient → `pending`
 *     with backoff min(2^(n−1)·30 s, 30 min), `failed` on the 5th; config →
 *     `pending` again in 60 s WITHOUT spending an attempt (the 24-hour
 *     expiry ends it); permanent → `failed` with the code; an unknown
 *     outcome (a timeout after the request left) → `failed 'stale'`.
 *
 * Every final write wipes `sealed_secret` (the 0089 CHECK refuses a final
 * row that keeps it). Only codes are stored or logged — never an address,
 * a subject, a body or a provider message.
 */
@Injectable()
export class MailSender {
  private readonly logger = new Logger('MailSender');

  private readonly attachmentMaxBytes: number;
  private readonly renderBudgetMs: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMAIL_GATEWAY) private readonly gateway: EmailGateway,
    /**
     * Story 2-9a — the send-time attachment port (D6). Nest always injects
     * the module's singleton; a sender constructed WITHOUT one (a suite's
     * bare `new MailSender(db, gateway)`) sends every row as rendered at the
     * claim, attaching nothing.
     */
    @Optional() @Inject(MailAttachmentRegistry) private readonly attachments?: MailAttachmentRegistry,
    @Optional() @Inject(MAIL_SENDER_OPTIONS) options?: MailSenderOptions,
  ) {
    this.attachmentMaxBytes = options?.attachmentMaxBytes ?? EMAIL_ATTACHMENT_MAX_BYTES;
    this.renderBudgetMs = options?.renderBudgetMs ?? EMAIL_ATTACHMENT_RENDER_BUDGET_MS;
  }

  async sendDue(tenantId: string, limit?: number, options: SendDueOptions = {}): Promise<MailSendSummary> {
    const config = mailConfigFromEnv();
    const take = Math.max(0, Math.min(limit ?? config.maxPerTick, config.maxPerTick));
    const reserve = Math.max(0, Math.trunc(options.priorityReserve ?? 0));

    const claim = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const stale = await tx
        .update(emailMessages)
        .set({ status: 'failed', errorCode: 'stale', sealedSecret: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.status, 'sending'),
            sql`${emailMessages.updatedAt} < now() - ${secs(EMAIL_SENDING_STALE_MS)}`,
          ),
        )
        .returning({ id: emailMessages.id });

      const expired = await tx
        .update(emailMessages)
        .set({ status: 'expired', errorCode: 'expired', sealedSecret: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.status, 'pending'),
            sql`${emailMessages.createdAt} < now() - ${secs(EMAIL_PENDING_EXPIRY_MS)}`,
          ),
        )
        .returning({ id: emailMessages.id });

      const purged = (await tx.execute(sql`
        delete from email_messages
        where id in (
          select id from email_messages
          where tenant_id = ${tenantId}
            and status in (${sql.join(EMAIL_FINAL_STATUSES.map((s) => sql`${s}`), sql`, `)})
            and updated_at < now() - make_interval(days => ${EMAIL_RETENTION_DAYS})
          limit ${EMAIL_PURGE_BATCH}
        )
        returning id
      `)) as unknown as { id: string }[];

      // Story 5-2b (A7, D7) — account mail (priority 0) first, up to the
      // limit or the worker's per-tenant reserve, whichever is larger; then
      // client notices (priority 1) with what the limit has left. One
      // transaction, both FOR UPDATE SKIP LOCKED (two senders never claim one row).
      const accountTake = Math.max(take, reserve);
      const accountDue = accountTake === 0 ? [] : await dueClaimQuery(tx, tenantId, 0, accountTake);
      const clientTake = Math.max(0, take - accountDue.length);
      const clientDue = clientTake === 0 ? [] : await dueClaimQuery(tx, tenantId, 1, clientTake);
      const due = [...accountDue, ...clientDue];

      const inFlight: Claimed[] = [];
      let skipped = 0;
      let failed = 0;
      for (const row of due) {
        const final = (status: 'skipped' | 'failed', code: string) =>
          tx
            .update(emailMessages)
            .set({ status, errorCode: code, sealedSecret: null, updatedAt: sql`now()` })
            .where(eq(emailMessages.id, row.id));
        if (this.gateway.mode === 'off' || config.provider === 'off') {
          await final('skipped', 'provider-off');
          skipped += 1;
          continue;
        }
        if (!addressAllowed(config, row.toEmail)) {
          await final('skipped', 'allowlist');
          skipped += 1;
          continue;
        }
        let secret: string | null = null;
        if (row.sealedSecret !== null) {
          try {
            secret = openEmailSecret(row.sealedSecret, row.tenantId, row.id);
          } catch {
            await final('failed', 'unsealable');
            failed += 1;
            continue;
          }
        }
        let email: OutgoingEmail;
        try {
          if (!TEMPLATES.has(row.template) || config.webBaseUrl === null) throw new Error('cannot render');
          const rendered = renderEmail(row.template as EmailTemplate, row.params, {
            tenantId: row.tenantId,
            to: row.toEmail,
            webBaseUrl: config.webBaseUrl,
            secret,
            fallbackReplyTo: config.replyTo,
          });
          email = {
            id: row.id,
            tenantId: row.tenantId,
            template: row.template as EmailTemplate,
            to: row.toEmail,
            fromName: rendered.fromName,
            replyTo: rendered.replyTo ?? config.replyTo,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
          };
        } catch {
          await final('failed', 'render');
          failed += 1;
          continue;
        }
        await tx
          .update(emailMessages)
          .set({ status: 'sending', updatedAt: sql`now()` })
          .where(eq(emailMessages.id, row.id));
        inFlight.push({ row, email });
      }
      return { stale: stale.length, expired: expired.length, purged: purged.length, claimed: due.length, skipped, failed, inFlight };
    });

    const base = {
      claimed: claim.claimed,
      stale: claim.stale,
      expired: claim.expired,
      purged: claim.purged,
      skipped: claim.skipped,
    };
    if (claim.inFlight.length === 0) {
      return { ...base, attempted: 0, sent: 0, failed: claim.failed, retried: 0, configCodes: [] };
    }

    // Story 5-1a (code review) — one message at a time, each in its OWN
    // pair of short tenant transactions around the provider call:
    //  - just before the send, re-check the row is still `sending` and touch
    //    `updated_at` (a cancel after the claim is honoured — never sent —
    //    and a long batch's later rows never age past the stale bound while
    //    they wait their turn);
    //  - right after it, write that row's outcome (a shutdown mid-batch loses
    //    at most the one in flight, which the stale sweep then fails).
    // Counters move only when the guarded update matched a row.
    let attempted = 0;
    let sent = 0;
    let failed = claim.failed;
    let retried = 0;
    const configCodes = new Set<string>();
    // Story 2-9a (A15) — the attachment step's per-call state: the memo
    // (successes only, keyed kind|client|ref — two recipients, one render) and
    // the shared render budget.
    const memo = new Map<string, EmailAttachment>();
    const budget = { spentMs: 0 };
    for (const inFlight of claim.inFlight) {
      let claimed = inFlight;
      // ── story 2-9a: 1. the attachment render, 2. a pure re-render ──────
      if (inFlight.row.attachmentKind !== null && inFlight.row.attachmentRef !== null && this.attachments !== undefined) {
        const step = await this.attachStep(tenantId, inFlight, memo, budget);
        if (step.kind === 'released') continue; // pending again, no attempt spent
        if (step.kind === 'outcome') {
          if (step.outcome === null) continue;
          if (step.outcome.kind === 'failed') failed += 1;
          else retried += 1;
          if (step.outcome.configCode !== null) configCodes.add(step.outcome.configCode);
          continue;
        }
        claimed = step.claimed;
      }
      // ── 3. the live re-check and touch, 4. the send ─────────────────────
      const live = await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .update(emailMessages)
          .set({ updatedAt: sql`now()` })
          .where(and(eq(emailMessages.id, claimed.row.id), eq(emailMessages.status, 'sending')))
          .returning({ id: emailMessages.id }),
      );
      if (live.length === 0) continue; // cancelled (or swept) since the claim — never sent

      attempted += 1;
      let result: EmailSendResult;
      try {
        result = await this.gateway.send(claimed.email);
      } catch (err) {
        // The port never throws; a throw is a programming error. The row
        // stays `sending` and the stale sweep fails it — never a duplicate.
        this.logger.error(`email gateway threw for message ${claimed.row.id} — left to the stale sweep: ${(err as Error).name}`);
        continue;
      }

      const outcome = await withTenantTransaction(this.db, tenantId, (tx) => this.writeOutcome(tx, claimed, result));
      if (outcome === null) continue; // cancelled while the send was in flight — the cancel stands
      if (outcome.kind === 'sent') sent += 1;
      else if (outcome.kind === 'failed') failed += 1;
      else retried += 1;
      if (outcome.configCode !== null) configCodes.add(outcome.configCode);
    }

    return {
      ...base,
      attempted,
      sent,
      failed,
      retried,
      configCodes: [...configCodes].sort(),
    };
  }

  /**
   * Story 2-9a (decision 17, A14, A15, D7) — one claimed row's attachment,
   * BEFORE its live re-check and send (so a slow render never outlives the
   * check, and the body always matches what is attached):
   *
   *  - the call's render budget spent → the row is released to `pending`,
   *    due now, `attachment-deferred`, NO attempt spent (written here, not as
   *    a config fault — that would wait 60 s and log a deployment fault);
   *  - no renderer registered for the kind → `attachment-unavailable`
   *    (config: no attempt spent, pending + 60 s, the tick's config log);
   *  - the render throws → `attachment-failed` (transient: an attempt,
   *    backoff) — EXCEPT on the last allowed attempt, when the email is sent
   *    without the file (A14: the attachment never costs the email);
   *  - the renderer answers null (the GRN is not that client's, or is gone)
   *    → sent without the file, logged at error level;
   *  - larger than the bound → sent without the file;
   *  - otherwise attached.
   * The body is then re-rendered (pure) with the outcome. Logs carry ids only.
   */
  private async attachStep(
    tenantId: string,
    claimed: Claimed,
    memo: Map<string, EmailAttachment>,
    budget: { spentMs: number },
  ): Promise<
    | { kind: 'send'; claimed: Claimed }
    | { kind: 'released' }
    | { kind: 'outcome'; outcome: { kind: 'sent' | 'failed' | 'retried'; configCode: string | null } | null }
  > {
    const registry = this.attachments!;
    const { row } = claimed;
    const kind = row.attachmentKind!;
    const ref = row.attachmentRef!;
    const clientId = row.clientId;
    if (!registry.has(kind) || clientId === null) {
      const outcome = await withTenantTransaction(this.db, tenantId, (tx) =>
        this.writeOutcome(tx, claimed, { ok: false, code: 'attachment-unavailable' }),
      );
      return { kind: 'outcome', outcome };
    }
    const key = `${kind}|${clientId}|${ref}`;
    let file: EmailAttachment | null | undefined = memo.get(key);
    let state: ClientReceiptAttachmentState = 'none';
    if (file === undefined) {
      if (budget.spentMs >= this.renderBudgetMs) {
        await withTenantTransaction(this.db, tenantId, (tx) =>
          tx
            .update(emailMessages)
            .set({ status: 'pending', errorCode: 'attachment-deferred', nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
            .where(and(eq(emailMessages.id, row.id), eq(emailMessages.status, 'sending'))),
        );
        return { kind: 'released' };
      }
      const started = Date.now();
      try {
        file = await registry.render(kind, tenantId, clientId, ref);
      } catch (err) {
        budget.spentMs += Date.now() - started;
        if (row.attempts + 1 < EMAIL_MAX_ATTEMPTS) {
          this.logger.warn(`client-email.attachment-failed message=${row.id} attempt=${row.attempts + 1} error=${(err as Error).name}`);
          const outcome = await withTenantTransaction(this.db, tenantId, (tx) =>
            this.writeOutcome(tx, claimed, { ok: false, code: 'attachment-failed' }),
          );
          return { kind: 'outcome', outcome };
        }
        this.logger.error(`client-email.attachment-failed message=${row.id} attempt=${row.attempts + 1} — the last attempt: sent without the file`);
        file = null;
        state = 'failed';
      }
      budget.spentMs += Date.now() - started;
    }
    if (file === null) {
      if (state !== 'failed') this.logger.error(`client-email.attachment-missing message=${row.id} — sent without the file`);
      state = 'failed';
    } else if (file !== undefined && file.content.byteLength > this.attachmentMaxBytes) {
      state = 'too-large';
      this.logger.warn(`client-email.attachment-too-large message=${row.id} bytes=${file.content.byteLength} — sent without the file`);
    } else {
      state = 'attached';
      memo.set(key, file!);
    }
    const config = mailConfigFromEnv();
    let rendered;
    try {
      rendered = renderEmail(row.template as EmailTemplate, row.params, {
        tenantId: row.tenantId,
        to: row.toEmail,
        webBaseUrl: config.webBaseUrl ?? '',
        secret: null,
        fallbackReplyTo: config.replyTo,
        attachment: state,
      });
    } catch {
      // The claim's render of the same params succeeded, so this cannot
      // happen; if it ever does, the body rendered at the claim is sent
      // without the file rather than lose the email.
      return { kind: 'send', claimed };
    }
    const email: OutgoingEmail = {
      ...claimed.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(state === 'attached' ? { attachments: [file!] } : {}),
    };
    return { kind: 'send', claimed: { row, email } };
  }

  /**
   * One row's outcome, written only while it is still `sending` (a row
   * cancelled or swept meanwhile is never resurrected). Null when the guarded
   * update matched nothing.
   */
  private async writeOutcome(
    tx: TenantTx,
    claimed: Claimed,
    result: EmailSendResult,
  ): Promise<{ kind: 'sent' | 'failed' | 'retried'; configCode: string | null } | null> {
    const stillSending = and(eq(emailMessages.id, claimed.row.id), eq(emailMessages.status, 'sending'));
    const write = async (set: PgUpdateSetSource<typeof emailMessages>): Promise<boolean> =>
      (await tx.update(emailMessages).set({ ...set, updatedAt: sql`now()` }).where(stillSending).returning({ id: emailMessages.id })).length > 0;

    if (result.ok) {
      const ok = await write({
        status: 'sent',
        providerMessageId: result.providerMessageId,
        errorCode: null,
        sealedSecret: null,
        attempts: claimed.row.attempts + 1,
      });
      return ok ? { kind: 'sent', configCode: null } : null;
    }
    const code = boundedEmailCode(result.code);
    const kind = classifyEmailCode(code);
    if (kind === 'config') {
      const ok = await write({ status: 'pending', errorCode: code, nextAttemptAt: sql`now() + ${secs(EMAIL_CONFIG_FAULT_RETRY_MS)}` });
      return ok ? { kind: 'retried', configCode: code } : null;
    }
    if (kind === 'transient') {
      const attempts = claimed.row.attempts + 1;
      if (attempts < EMAIL_MAX_ATTEMPTS) {
        const ok = await write({
          status: 'pending',
          errorCode: code,
          attempts,
          nextAttemptAt: sql`now() + ${secs(emailBackoffMs(attempts))}`,
        });
        return ok ? { kind: 'retried', configCode: null } : null;
      }
      const ok = await write({ status: 'failed', errorCode: code, attempts, sealedSecret: null });
      return ok ? { kind: 'failed', configCode: null } : null;
    }
    // permanent, or an unknown outcome (counted as stale — never re-sent).
    const ok = await write({
      status: 'failed',
      errorCode: kind === 'unknown-outcome' ? 'stale' : code,
      attempts: claimed.row.attempts + 1,
      sealedSecret: null,
    });
    return ok ? { kind: 'failed', configCode: null } : null;
  }
}
