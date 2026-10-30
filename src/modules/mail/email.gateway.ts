import { Logger } from '@nestjs/common';
import { GetSuppressedDestinationCommand, SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { assertMailConfigured } from './mail.config';
import { boundedEmailCode, EMAIL_ERROR_CLASS, type EmailProvider, type EmailTemplate } from './mail-rules';
import type { EmailAttachment } from './mail-attachments';

/**
 * Story 5-1a — the `EmailGateway` port (the `PushGateway` model): the only
 * thing in the system that talks to a mail provider. Called ONLY by the
 * sender (`MailFacade.sendDue`), never inside a transaction.
 *
 * Three adapters, selected by the `EMAIL_PROVIDER` env MODE (never a
 * credential):
 *  - `off` (the default) — `UnconfiguredEmailGateway`; the facade queues
 *    every row `skipped`, and the sender never calls it;
 *  - `log` — `LogEmailGateway`: captures each message in memory (bounded;
 *    the e2e suites read it) and logs the template id and message id ONLY
 *    (the body carries the one-time link);
 *  - `ses` — `SesEmailGateway`: SES v2 in `AWS_REGION` (default
 *    ap-south-1), `maxAttempts: 1` (the sender owns retries) and a request
 *    timeout well under the 10-minute stale bound.
 *
 * `send` never throws: it resolves the provider's message id or a CODE —
 * never a provider message (SES messages name the address).
 */
export const EMAIL_GATEWAY = 'EMAIL_GATEWAY' as const;

/** One rendered message, as the sender hands it to the gateway. */
export interface OutgoingEmail {
  /** `email_messages.id` — the only id the log gateway prints. */
  readonly id: string;
  readonly tenantId: string;
  readonly template: EmailTemplate;
  readonly to: string;
  /** The From display name ("{tenant} via WMS"); the address is the gateway's `EMAIL_FROM`. */
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Story 2-9a — files rendered at send time (the receipt notice's GRN PDF); absent on every other mail. */
  readonly attachments?: readonly EmailAttachment[];
}

export type EmailSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly code: string };

export interface EmailGateway {
  readonly mode: EmailProvider;
  send(email: OutgoingEmail): Promise<EmailSendResult>;
}

/** `EMAIL_PROVIDER=off`: no provider. The sender never calls it (rows are `skipped`). */
export class UnconfiguredEmailGateway implements EmailGateway {
  readonly mode = 'off' as const;

  async send(): Promise<EmailSendResult> {
    return { ok: false, code: 'provider-off' };
  }
}

/** `EMAIL_PROVIDER=log`: captures every message in memory (bounded) and logs ids only. */
export class LogEmailGateway implements EmailGateway {
  readonly mode = 'log' as const;
  private readonly logger = new Logger('EmailGateway');
  /** Every message this process "sent" (the e2e suites read it). Bounded at 1,000. */
  readonly captured: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    if (this.captured.length >= 1000) this.captured.shift();
    this.captured.push(email);
    // Never the address, the subject or the body: the body carries the one-time link.
    this.logger.log(`log provider — ${email.template} message ${email.id} captured, not sent`);
    return { ok: true, providerMessageId: `log-${email.id}` };
  }
}

/** Node error codes that mean no connection was made — nothing left, safe to retry. */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * The code of an SES (smithy) or transport error. `phase` matters only when
 * no HTTP answer came back: before the send (the suppression read) nothing
 * was sent, so it is `network` (transient); during `SendEmail` the request
 * may have left, so it is `timeout` — an unknown outcome, never re-sent —
 * unless the error proves no connection was made.
 */
export function sesErrorCode(err: unknown, phase: 'precheck' | 'send'): string {
  if (typeof err !== 'object' || err === null) return phase === 'send' ? 'timeout' : 'network';
  const e = err as { name?: unknown; code?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === 'string' && e.name !== '' && e.name !== 'Error' ? e.name : null;
  const status = typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : null;
  // The SES sandbox refusing an unverified recipient: a config fault, told
  // apart by its message (read here, never stored or logged — it names the address).
  if (name === 'MessageRejected' && typeof e.message === 'string' && /not verified/i.test(e.message)) {
    return 'address-not-verified';
  }
  if (name !== null && EMAIL_ERROR_CLASS[name] !== undefined) return name;
  if (status !== null) {
    if (status >= 500 || status === 429) return `http-${status}`;
    return name === null ? `http-${status}` : boundedEmailCode(name);
  }
  // No HTTP answer at all.
  if (typeof e.code === 'string' && NOT_CONNECTED.has(e.code)) return 'network';
  return phase === 'send' ? 'timeout' : 'network';
}

/** RFC 5322 display name: a quoted string when printable ASCII, else RFC 2047 encoded-words (each ≤ 75 characters). */
export function fromHeader(displayName: string, address: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = displayName.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(flat)) {
    return `"${flat.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  }
  return `${encodedWords(flat)} <${address}>`;
}

/**
 * RFC 2047 caps an encoded-word at 75 characters: `=?UTF-8?B?` + `?=` leave
 * 63 for base64, i.e. at most 45 bytes of UTF-8 per word. The name is cut on
 * code-point boundaries (never inside a character's bytes), and the words are
 * joined by a single space (which decoders drop between adjacent words).
 */
const MAX_ENCODED_WORD_BYTES = 45;

export function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > MAX_ENCODED_WORD_BYTES && chunk !== '') {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(' ');
}

/** The SES request timeout: well under the 10-minute stale bound. */
export const SES_REQUEST_TIMEOUT_MS = 15_000;
export const SES_CONNECTION_TIMEOUT_MS = 3_000;

/**
 * SES v2. Before each send, `GetSuppressedDestination`: an address on the
 * account suppression list is `suppressed` (SES would otherwise accept and
 * silently drop it). Then `SendEmail` with a simple (text + HTML) body; the
 * answer's `MessageId` is the row's `provider_message_id`.
 */
export class SesEmailGateway implements EmailGateway {
  readonly mode = 'ses' as const;

  constructor(
    private readonly client: Pick<SESv2Client, 'send'>,
    private readonly fromAddress: string,
    private readonly defaultReplyTo: string | null,
  ) {}

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    try {
      await this.client.send(new GetSuppressedDestinationCommand({ EmailAddress: email.to }));
      return { ok: false, code: 'suppressed' };
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name !== 'NotFoundException') {
        return { ok: false, code: sesErrorCode(err, 'precheck') };
      }
      // NotFoundException: the address is not suppressed — send.
    }
    const replyTo = email.replyTo ?? this.defaultReplyTo;
    try {
      const response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: fromHeader(email.fromName, this.fromAddress),
          Destination: { ToAddresses: [email.to] },
          ...(replyTo === null ? {} : { ReplyToAddresses: [replyTo] }),
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: email.text, Charset: 'UTF-8' },
                Html: { Data: email.html, Charset: 'UTF-8' },
              },
              // Story 2-9a — SES v2 `Message.Attachments` (simple content).
              ...(email.attachments === undefined || email.attachments.length === 0
                ? {}
                : {
                    Attachments: email.attachments.map((file) => ({
                      FileName: file.filename,
                      ContentType: file.contentType,
                      RawContent: file.content,
                      ContentDisposition: 'ATTACHMENT' as const,
                    })),
                  }),
            },
          },
        }),
      );
      const messageId = response.MessageId;
      if (typeof messageId !== 'string' || messageId === '') {
        // Accepted without an id: SES took it — record that, never re-send.
        return { ok: true, providerMessageId: 'unknown' };
      }
      return { ok: true, providerMessageId: messageId.slice(0, 200) };
    } catch (err) {
      return { ok: false, code: sesErrorCode(err, 'send') };
    }
  }
}

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;
export const DEFAULT_SES_REGION = 'ap-south-1';

/**
 * Selects the adapter from the env (boot time). Runs the mail boot check
 * first, so a deployment that asked for mail without `EMAIL_FROM`,
 * `WEB_BASE_URL` or `EMAIL_SEAL_KEY` refuses to start, naming the variable.
 */
export function emailGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): EmailGateway {
  const config = assertMailConfigured(env);
  if (config.provider === 'off') return new UnconfiguredEmailGateway();
  if (config.provider === 'log') return new LogEmailGateway();
  const region = env.AWS_REGION === undefined || env.AWS_REGION.trim() === '' ? DEFAULT_SES_REGION : env.AWS_REGION.trim();
  if (!REGION_RE.test(region)) {
    throw new Error(`AWS_REGION must be an AWS region such as ap-south-1 (got "${region}")`);
  }
  const client = new SESv2Client({
    region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SES_CONNECTION_TIMEOUT_MS,
      requestTimeout: SES_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  return new SesEmailGateway(client, config.from!, config.replyTo);
}
