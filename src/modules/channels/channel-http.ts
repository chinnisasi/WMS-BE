/**
 * The channels module's HTTP transport primitive (story 7.2, RD-6): the
 * request the real Shopify arms ride — `node:https` (the BUILT-IN module, no
 * dependency added and none wanted; grep-verified greenfield). Chosen over
 * the runtime's `fetch` deliberately: the arms must behave IDENTICALLY
 * everywhere the code can run — the test workers run node (jest), production
 * runs bun — and the two runtimes' `fetch` differ in TLS override plumbing
 * while `node:https` is one client with one semantics. No retry here — the
 * OUTBOX RELAY owns the retry/backoff policy (FQ-3: nothing hand-rolls a
 * second retry budget).
 *
 * The transport carries a hard per-call timeout (`CHANNEL_HTTP_TIMEOUT_MS`,
 * default 10 000): a hung channel call must release its slot — the delivery
 * handlers meter the failure and the OUTBOX RELAY (not this file) owns the
 * retry/backoff policy (FQ-3: nothing hand-rolls a second retry budget).
 *
 * Credential values and body content never reach a log line: the helpers
 * here log nothing at all — failures surface as typed attempts the callers
 * meter with `error` strings that name the SHAPE of the failure, never the
 * request. Credential values and body content never appear in an error
 * (a failed header shape is a `bad-arg` naming the header NAME).
 *
 * TLS verification honors the STANDARD escape hatch
 * (`NODE_TLS_REJECT_UNAUTHORIZED="0"`) per request — the transport-shape
 * stub tests run the arms against a local self-signed server; production
 * sets nothing (the default validates). The timeout env parse follows the
 * poll-gate conventions (`parseChannelsSyncPollMs`): unset = default,
 * anything invalid boots loud.
 */
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

/** The per-call timeout default (RD-6; Shopify's API SLO sits inside it). */
export const DEFAULT_CHANNEL_HTTP_TIMEOUT_MS = 10_000;

/** The env name the timeout is read from. */
export const CHANNEL_HTTP_TIMEOUT_MS_ENV = 'CHANNEL_HTTP_TIMEOUT_MS';

/** The parse ceiling — a timeout above five minutes is a misconfiguration. */
export const MAX_CHANNEL_HTTP_TIMEOUT_MS = 300_000;

/**
 * The per-call timeout, parsed per the poll-gate conventions: unset (or
 * blank) = the default, an invalid value THROWS — boots loud, never a
 * silent default under a broken config. Called at arm-construction time (the
 * registry registrations are import-time), so a bad value fails the boot.
 */
export function parseChannelHttpTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_CHANNEL_HTTP_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CHANNEL_HTTP_TIMEOUT_MS) {
    throw new Error(
      `Invalid ${CHANNEL_HTTP_TIMEOUT_MS_ENV} "${raw}" — must be an integer between 1 and ${MAX_CHANNEL_HTTP_TIMEOUT_MS} (milliseconds).`,
    );
  }
  return value;
}

/** The parsed timeout (parsed once at the arms' construction). */
export const CHANNEL_HTTP_TIMEOUT_MS = parseChannelHttpTimeoutMs(
  process.env[CHANNEL_HTTP_TIMEOUT_MS_ENV],
);

/** One (never-logged) HTTP exchange's outcome, the arms' interpretation input. */
export interface ChannelHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The failure shapes the arms map onto delivery attempts. */
export class ChannelHttpError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'not-ok' | 'bad-arg',
    readonly status: number | null,
    detail: string,
  ) {
    super(`${kind}${status === null ? '' : ` (status ${status})`}: ${detail}`);
    this.name = 'ChannelHttpError';
  }
}

/**
 * One JSON HTTP/HTTPS request/response exchange against a channel API. A
 * transport failure is the caller's delivery outcome, once, honestly
 * metered. The response body is kept as text (the arms interpret + bound it
 * for logs/meters themselves); JSON-serializing the request body is the
 * arms' (this function takes the SHAPED object).
 */
export async function channelHttpRequest(args: {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}): Promise<ChannelHttpResponse> {
  const url = new URL(args.url);
  if (url.protocol !== 'https:') {
    throw new ChannelHttpError('bad-arg', null, 'channel HTTP requests require https');
  }
  const signal = AbortSignal.timeout(CHANNEL_HTTP_TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(args.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...args.headers,
  };
  const bodyText = args.body === undefined ? undefined : JSON.stringify(args.body);

  type HttpResponse = IncomingMessage & { statusCode?: number | undefined };
  let response: HttpResponse;
  try {
    response = await new Promise<HttpResponse>((resolve, reject) => {
      const request = https.request(
        {
          // URL parsing IS the host/port/path normalization — a malformed
          // URL throws above (the caller's bad-arg shape).
          host: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: args.method,
          headers,
          // The standard escape hatch, read PER REQUEST: the transport-
          // shape stub tests run the arms against a local self-signed
          // server; production sets nothing (the default validates).
          rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
          signal,
        },
        (res) => resolve(res),
      );
      request.on('error', reject);
      if (bodyText !== undefined) request.write(bodyText);
      request.end();
    });
  } catch (err) {
    if (signal.aborted) {
      throw new ChannelHttpError('timeout', null, `channel call exceeded ${CHANNEL_HTTP_TIMEOUT_MS}ms`);
    }
    throw new ChannelHttpError(
      'network',
      null,
      err instanceof Error ? err.message.slice(0, 200) : 'network error',
    );
  }

  const chunks: string[] = [];
  const status = response.statusCode ?? 0;
  const body: string = await new Promise((resolve, reject) => {
    response.on('data', (chunk: string | Buffer) => chunks.push(String(chunk)));
    response.on('end', () => resolve(chunks.join('')));
    response.on('error', reject);
  });
  if (!signal.aborted && status < 200) {
    // A transport-level protocol failure (no status line).
    throw new ChannelHttpError('network', null, `no response status (connected, then closed)`);
  }
  if (status >= 400) {
    throw new ChannelHttpError(
      'not-ok',
      status,
      // The response BODY could echo supplied material — the status and a
      // bounded prefix are the honest bound; the caller's meter carries it.
      (body || '(empty body)').slice(0, 200),
    );
  }
  return { status, body };
}