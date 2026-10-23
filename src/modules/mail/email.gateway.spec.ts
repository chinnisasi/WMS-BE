import {
  AccountSuspendedException,
  BadRequestException,
  GetSuppressedDestinationCommand,
  InternalServiceErrorException,
  LimitExceededException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  NotFoundException,
  SendEmailCommand,
  SendingPausedException,
  SESv2Client,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import {
  LogEmailGateway,
  SesEmailGateway,
  emailGatewayFromEnv,
  fromHeader,
  sesErrorCode,
  type OutgoingEmail,
} from './email.gateway';
import { classifyEmailCode, emailBackoffMs } from './mail-rules';

// Story 5-1a — the SES v2 adapter against a mocked SDK (no account, no
// network): the suppression pre-check, the request it sends, and the
// transient / config / permanent / unknown-outcome classification of every
// answer the spec names.

const meta = (httpStatusCode: number) => ({ $metadata: { httpStatusCode } });

const EMAIL: OutgoingEmail = {
  id: '01923456-7890-7abc-8def-0123456789ab',
  tenantId: '01900000-0000-7000-8000-00000000000a',
  template: 'user-invite',
  to: 'a@x.in',
  fromName: 'Acme Logistics via WMS',
  replyTo: 'owner@acme.in',
  subject: 'Acme Logistics has invited you to WMS',
  text: 'text body',
  html: '<p>html body</p>',
};

function notSuppressed(ses: ReturnType<typeof mockClient>): void {
  ses.on(GetSuppressedDestinationCommand).rejects(new NotFoundException({ message: 'not on the list', ...meta(404) }));
}

describe('the SES email gateway (story 5-1a, mocked SDK)', () => {
  const ses = mockClient(SESv2Client);
  const gateway = () => new SesEmailGateway(new SESv2Client({ region: 'ap-south-1' }), 'no-reply@mail.wms.in', 'support@wms.in');

  beforeEach(() => ses.reset());

  it('sends one SendEmail after a clean suppression read: From "<name> via WMS", To, Reply-To, text + HTML; resolves the MessageId', async () => {
    notSuppressed(ses);
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-message-1' });
    const result = await gateway().send(EMAIL);
    expect(result).toEqual({ ok: true, providerMessageId: 'ses-message-1' });
    expect(ses.commandCalls(GetSuppressedDestinationCommand)[0]!.args[0].input).toEqual({ EmailAddress: 'a@x.in' });
    const sent = ses.commandCalls(SendEmailCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[0].input).toEqual({
      FromEmailAddress: '"Acme Logistics via WMS" <no-reply@mail.wms.in>',
      Destination: { ToAddresses: ['a@x.in'] },
      ReplyToAddresses: ['owner@acme.in'],
      Content: {
        Simple: {
          Subject: { Data: 'Acme Logistics has invited you to WMS', Charset: 'UTF-8' },
          Body: { Text: { Data: 'text body', Charset: 'UTF-8' }, Html: { Data: '<p>html body</p>', Charset: 'UTF-8' } },
        },
      },
    });
  });

  it('falls back to EMAIL_REPLY_TO when the message has no Reply-To of its own', async () => {
    notSuppressed(ses);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm' });
    await gateway().send({ ...EMAIL, replyTo: null });
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.ReplyToAddresses).toEqual(['support@wms.in']);
  });

  it('a suppressed address is `suppressed` (permanent) and is never sent', async () => {
    ses.on(GetSuppressedDestinationCommand).resolves({ SuppressedDestination: { EmailAddress: 'a@x.in', Reason: 'BOUNCE', LastUpdateTime: new Date() } });
    const result = await gateway().send(EMAIL);
    expect(result).toEqual({ ok: false, code: 'suppressed' });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(classifyEmailCode('suppressed')).toBe('permanent');
  });

  it('a suppression-read failure sends nothing and is classified like any other answer (nothing left: a timeout there is `network`, transient)', async () => {
    ses.on(GetSuppressedDestinationCommand).rejects(new TooManyRequestsException({ message: 'slow down', ...meta(429) }));
    expect(await gateway().send(EMAIL)).toEqual({ ok: false, code: 'TooManyRequestsException' });
    ses.reset();
    ses.on(GetSuppressedDestinationCommand).rejects(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(await gateway().send(EMAIL)).toEqual({ ok: false, code: 'network' });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  const cases: readonly [string, () => unknown, string, string][] = [
    ['throttling', () => new TooManyRequestsException({ message: 'rate', ...meta(429) }), 'TooManyRequestsException', 'transient'],
    ['the daily quota (waits, spends no attempt — retrying would fail every queued invite)', () => new LimitExceededException({ message: 'quota', ...meta(400) }), 'LimitExceededException', 'config'],
    ['an unnamed 429', () => Object.assign(new Error('slow down'), { ...meta(429) }), 'http-429', 'transient'],
    ['a 429 under a name SES never documented', () => Object.assign(new Error('slow'), { name: 'SlowDownException', ...meta(429) }), 'http-429', 'transient'],
    ['an SES internal error', () => new InternalServiceErrorException({ message: 'oops', ...meta(500) }), 'InternalServiceErrorException', 'transient'],
    ['an unnamed 5xx', () => Object.assign(new Error('bad gateway'), { name: 'SomethingNew', ...meta(502) }), 'http-502', 'transient'],
    ['a suspended account', () => new AccountSuspendedException({ message: 'suspended', ...meta(400) }), 'AccountSuspendedException', 'config'],
    ['paused sending', () => new SendingPausedException({ message: 'paused', ...meta(400) }), 'SendingPausedException', 'config'],
    ['an unverified MAIL FROM', () => new MailFromDomainNotVerifiedException({ message: 'mail from', ...meta(400) }), 'MailFromDomainNotVerifiedException', 'config'],
    ['NotFound on the send (a missing configuration set / identity)', () => new NotFoundException({ message: 'nf', ...meta(404) }), 'NotFoundException', 'config'],
    ['denied access', () => Object.assign(new Error('denied'), { name: 'AccessDeniedException', ...meta(403) }), 'AccessDeniedException', 'config'],
    ['no credentials', () => Object.assign(new Error('Could not load credentials'), { name: 'CredentialsProviderError' }), 'CredentialsProviderError', 'config'],
    [
      'the sandbox refusing an unverified recipient',
      () => new MessageRejected({ message: 'Email address is not verified. The following identities failed the check in region AP-SOUTH-1: a@x.in', ...meta(400) }),
      'address-not-verified',
      'config',
    ],
    ['a bad request', () => new BadRequestException({ message: 'bad', ...meta(400) }), 'BadRequestException', 'permanent'],
    ['any other rejection', () => new MessageRejected({ message: 'Illegal address', ...meta(400) }), 'MessageRejected', 'permanent'],
    ['an unlisted 4xx', () => Object.assign(new Error('teapot'), { name: 'TeapotException', ...meta(418) }), 'TeapotException', 'permanent'],
    ['a request timeout (the request may have left)', () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout', 'unknown-outcome'],
    ['a reset connection mid-send', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'timeout', 'unknown-outcome'],
    ['a refused connection (nothing left)', () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'network', 'transient'],
  ];

  it.each(cases)('SendEmail failing with %s → code %s, class %s', async (_label, error, code, kind) => {
    notSuppressed(ses);
    ses.on(SendEmailCommand).rejects(error() as Error);
    const result = await gateway().send(EMAIL);
    expect(result).toEqual({ ok: false, code });
    expect(classifyEmailCode(code)).toBe(kind);
  });

  it('never returns a provider message (it names the address): only the code', async () => {
    notSuppressed(ses);
    ses.on(SendEmailCommand).rejects(new MessageRejected({ message: 'Email address is not verified: a@x.in', ...meta(400) }));
    const result = await gateway().send(EMAIL);
    expect(JSON.stringify(result)).not.toContain('a@x.in');
  });

  it('sesErrorCode: a non-object throw is an unknown outcome on the send, nothing-left on the pre-check', () => {
    expect(sesErrorCode('boom', 'send')).toBe('timeout');
    expect(sesErrorCode('boom', 'precheck')).toBe('network');
  });
});

describe('the From header (story 5-1a, decision 6)', () => {
  it('quotes a printable-ASCII name, escaping quotes and backslashes', () => {
    expect(fromHeader('Acme "Best" \\ Co via WMS', 'no-reply@wms.in')).toBe('"Acme \\"Best\\" \\\\ Co via WMS" <no-reply@wms.in>');
  });

  it('a name with CR/LF cannot add a header line', () => {
    const header = fromHeader('Evil\r\nBcc: x@y.in via WMS', 'no-reply@wms.in');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('encodes a non-ASCII name as an RFC 2047 encoded-word', () => {
    const header = fromHeader('मुंबई Logistics via WMS', 'no-reply@wms.in');
    expect(header).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@wms\.in>$/);
    const encoded = /\?B\?([^?]+)\?=/.exec(header)![1]!;
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('मुंबई Logistics via WMS');
  });

  it('a long non-ASCII name becomes several encoded-words, each ≤ 75 characters, cut on character boundaries', () => {
    const name = 'श्री गणेश लॉजिस्टिक्स एंड वेयरहाउसिंग प्राइवेट लिमिटेड मुंबई via WMS';
    const header = fromHeader(name, 'no-reply@wms.in');
    expect(header.endsWith(' <no-reply@wms.in>')).toBe(true);
    const words = header.slice(0, -' <no-reply@wms.in>'.length).split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    // Each word decodes on its own (no character split across words); together they are the name.
    const decoded = words.map((word) => {
      const text = Buffer.from(/\?B\?([^?]+)\?=/.exec(word)![1]!, 'base64').toString('utf8');
      expect(text).not.toContain('\uFFFD');
      return text;
    });
    expect(decoded.join('')).toBe(name);
  });
});

describe('the backoff and the log gateway (story 5-1a)', () => {
  it('backoff is min(2^(n−1)·30 s, 30 min)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(emailBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  });

  it('the log gateway captures the message and answers a log message id', async () => {
    const log = new LogEmailGateway();
    expect(await log.send(EMAIL)).toEqual({ ok: true, providerMessageId: `log-${EMAIL.id}` });
    expect(log.captured).toEqual([EMAIL]);
  });
});

describe('emailGatewayFromEnv — the boot check (story 5-1a)', () => {
  const KEY = 'unit-only-email-seal-key-0123456789abcdef';
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('off (the default) needs nothing', () => {
    delete process.env.EMAIL_SEAL_KEY;
    expect(emailGatewayFromEnv({}).mode).toBe('off');
  });

  it('ses without EMAIL_FROM refuses, naming it', () => {
    process.env.EMAIL_SEAL_KEY = KEY;
    expect(() => emailGatewayFromEnv({ EMAIL_PROVIDER: 'ses', WEB_BASE_URL: 'https://app.wms.in' })).toThrow(/EMAIL_FROM/);
  });

  it('log without WEB_BASE_URL refuses, naming it', () => {
    process.env.EMAIL_SEAL_KEY = KEY;
    expect(() => emailGatewayFromEnv({ EMAIL_PROVIDER: 'log', EMAIL_FROM: 'no-reply@wms.in' })).toThrow(/WEB_BASE_URL/);
  });

  it('ses or log without EMAIL_SEAL_KEY refuses, naming it; a short _PREVIOUS refuses too', () => {
    delete process.env.EMAIL_SEAL_KEY;
    const env = { EMAIL_PROVIDER: 'log', EMAIL_FROM: 'no-reply@wms.in', WEB_BASE_URL: 'http://localhost:3001' };
    expect(() => emailGatewayFromEnv(env)).toThrow(/EMAIL_SEAL_KEY is required/);
    process.env.EMAIL_SEAL_KEY = 'too-short';
    expect(() => emailGatewayFromEnv(env)).toThrow(/EMAIL_SEAL_KEY is required/);
    process.env.EMAIL_SEAL_KEY = KEY;
    process.env.EMAIL_SEAL_KEY_PREVIOUS = 'short';
    expect(() => emailGatewayFromEnv(env)).toThrow(/EMAIL_SEAL_KEY_PREVIOUS/);
    delete process.env.EMAIL_SEAL_KEY_PREVIOUS;
    expect(emailGatewayFromEnv(env).mode).toBe('log');
  });

  it('an unknown provider, a bad address, a non-https production URL, a bad allowlist and a bad cap all refuse by name', () => {
    process.env.EMAIL_SEAL_KEY = KEY;
    const ok = { EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'no-reply@wms.in', WEB_BASE_URL: 'https://app.wms.in' };
    expect(() => emailGatewayFromEnv({ ...ok, EMAIL_PROVIDER: 'smtp' })).toThrow(/EMAIL_PROVIDER/);
    expect(() => emailGatewayFromEnv({ ...ok, EMAIL_FROM: 'WMS <no-reply@wms.in>' })).toThrow(/EMAIL_FROM/);
    expect(() => emailGatewayFromEnv({ ...ok, EMAIL_REPLY_TO: 'not an address' })).toThrow(/EMAIL_REPLY_TO/);
    expect(() => emailGatewayFromEnv({ ...ok, WEB_BASE_URL: 'http://app.wms.in', NODE_ENV: 'production' })).toThrow(/https/);
    expect(() => emailGatewayFromEnv({ ...ok, WEB_BASE_URL: 'app.wms.in' })).toThrow(/WEB_BASE_URL/);
    expect(() => emailGatewayFromEnv({ ...ok, WEB_BASE_URL: 'https://app.wms.in/?x=1' })).toThrow(/WEB_BASE_URL/);
    expect(() => emailGatewayFromEnv({ ...ok, EMAIL_ALLOWLIST_DOMAINS: 'example.in, not a domain' })).toThrow(/EMAIL_ALLOWLIST_DOMAINS/);
    expect(() => emailGatewayFromEnv({ ...ok, EMAIL_MAX_PER_TICK: '0' })).toThrow(/EMAIL_MAX_PER_TICK/);
    expect(() => emailGatewayFromEnv({ ...ok, AWS_REGION: 'mumbai' })).toThrow(/AWS_REGION/);
    expect(emailGatewayFromEnv(ok).mode).toBe('ses');
  });
});
