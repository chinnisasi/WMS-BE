import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import { PUSH_BATCH_SIZE, PUSH_GATEWAY_MODES, boundedCode, type PushGatewayMode, type PushTab } from './push-rules';

/**
 * The `PushGateway` port (story 9-2b, the `EwayGateway` model): the only
 * thing in the system that talks to a push provider. Called ONLY by the push
 * sender (`NotificationsFacade.sendDuePushes`), never from an outbox handler
 * — a provider outage must not be able to stall the relay.
 *
 * Two adapters, selected by the `PUSH_GATEWAY` env MODE (never a credential):
 *  - `unconfigured` (the default) — records each send it would have made and
 *    makes no network call; every ticket is `{ok}`;
 *  - `expo` — one https POST per batch to Expo's push API with
 *    `EXPO_ACCESS_TOKEN`; the boot fails when the token is missing.
 *
 * No receipt polling (the spec's Never list): a ticket `ok` means Expo
 * accepted the message, which is all the ledger records.
 */
export const PUSH_GATEWAY = 'PUSH_GATEWAY' as const;

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const DEFAULT_PUSH_HTTP_TIMEOUT_MS = 10_000;

/** One message, exactly as it goes on the wire (Expo's push message shape). */
export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  /** The ONLY data a push carries: what it is and which inbox tab to open. */
  readonly data: { readonly kind: string; readonly tab: PushTab };
  readonly ttl: number;
  /** Android: the `work` channel the handheld creates before it asks permission. */
  readonly channelId: 'work';
  readonly priority: 'high';
}

/** One outcome per message, in input order. `code` is a provider code — never a message. */
export type PushTicket = { readonly ok: true } | { readonly ok: false; readonly code: string };

export interface PushGateway {
  readonly mode: PushGatewayMode;
  /** Sends at most `PUSH_BATCH_SIZE` messages; resolves one ticket per message, in order. Never throws. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
}

/** The default: no provider. Records what it would have sent; no network. */
export class UnconfiguredPushGateway implements PushGateway {
  readonly mode = 'unconfigured' as const;
  private readonly logger = new Logger('PushGateway');
  /** Every message this process would have sent (the e2e suite reads it). Bounded. */
  readonly recorded: PushMessage[] = [];

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    for (const message of messages) {
      if (this.recorded.length >= 10_000) this.recorded.shift();
      this.recorded.push(message);
    }
    // Never the token: kind and tab are the whole of a push's content.
    this.logger.log(
      `unconfigured — would have sent ${messages.length} push(es): ${messages.map((m) => `${m.data.kind}/${m.data.tab}`).join(', ')}`,
    );
    return messages.map(() => ({ ok: true as const }));
  }
}

/**
 * Expo's push API. Whole-request outcomes apply to every message of the
 * batch: a transport failure → `network` / `timeout`; an HTTP status ≥ 400
 * → `http-<status>` (the classification table decides: 401/403 config,
 * 429/5xx transient, any other 4xx permanent). A 2xx is read per ticket:
 * `status: ok` → `{ok}`; `status: error` → its `details.error` code
 * (`unknown-error` when absent). A 2xx whose `data` is not one ticket per
 * message is `bad-response` for the whole batch. Only codes are returned —
 * Expo's error MESSAGES contain the token and are never read.
 */
export class ExpoPushGateway implements PushGateway {
  readonly mode = 'expo' as const;

  constructor(
    private readonly accessToken: string,
    private readonly url: string = EXPO_PUSH_URL,
    private readonly timeoutMs: number = DEFAULT_PUSH_HTTP_TIMEOUT_MS,
  ) {
    if (new URL(url).protocol !== 'https:') {
      throw new Error('the Expo push gateway requires an https URL');
    }
  }

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) return [];
    if (messages.length > PUSH_BATCH_SIZE) {
      throw new Error(`a push batch is at most ${PUSH_BATCH_SIZE} messages (got ${messages.length})`);
    }
    const all = (code: string): PushTicket[] => messages.map(() => ({ ok: false as const, code }));
    let response: { status: number; body: string };
    try {
      response = await this.post(JSON.stringify(messages));
    } catch (err) {
      return all(err instanceof PushTimeout ? 'timeout' : 'network');
    }
    if (response.status >= 400 || response.status < 200) {
      return all(`http-${response.status}`);
    }
    let data: unknown;
    try {
      data = (JSON.parse(response.body) as { data?: unknown }).data;
    } catch {
      return all('bad-response');
    }
    if (!Array.isArray(data) || data.length !== messages.length) {
      return all('bad-response');
    }
    return data.map((ticket): PushTicket => {
      if (typeof ticket === 'object' && ticket !== null && (ticket as { status?: unknown }).status === 'ok') {
        return { ok: true };
      }
      const details = (ticket as { details?: unknown } | null)?.details;
      const error = typeof details === 'object' && details !== null ? (details as { error?: unknown }).error : undefined;
      return { ok: false, code: typeof error === 'string' ? boundedCode(error) : 'unknown-error' };
    });
  }

  private post(body: string): Promise<{ status: number; body: string }> {
    const url = new URL(this.url);
    const signal = AbortSignal.timeout(this.timeoutMs);
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${this.accessToken}`,
          },
          // The channel transports' escape hatch, read per request: the
          // gateway suite runs against a local self-signed stub; production
          // sets nothing (the default validates).
          rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
          signal,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            if (signal.aborted) reject(new PushTimeout());
            else resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', (err) => reject(signal.aborted ? new PushTimeout() : err));
        },
      );
      request.on('error', (err) => reject(signal.aborted ? new PushTimeout() : err));
      request.write(body);
      request.end();
    });
  }
}

class PushTimeout extends Error {
  constructor() {
    super('push request timed out');
  }
}

/** `PUSH_HTTP_TIMEOUT_MS` — a positive integer of milliseconds; default 10 s. */
export function parsePushHttpTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PUSH_HTTP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PUSH_HTTP_TIMEOUT_MS must be a positive integer of milliseconds (got "${raw}")`);
  }
  return parsed;
}

/**
 * Selects the adapter from the env (boot time): `PUSH_GATEWAY` unset or
 * `unconfigured` → the recording no-op; `expo` → Expo, which REQUIRES
 * `EXPO_ACCESS_TOKEN` (the boot fails loudly without it — a deployment that
 * asked for pushes must not silently send none). Anything else fails the boot.
 */
export function pushGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): PushGateway {
  const mode = env.PUSH_GATEWAY === undefined || env.PUSH_GATEWAY === '' ? 'unconfigured' : env.PUSH_GATEWAY;
  if (!(PUSH_GATEWAY_MODES as readonly string[]).includes(mode)) {
    throw new Error(`PUSH_GATEWAY must be one of ${PUSH_GATEWAY_MODES.join(', ')} (got "${mode}")`);
  }
  if (mode === 'unconfigured') return new UnconfiguredPushGateway();
  const token = env.EXPO_ACCESS_TOKEN;
  if (token === undefined || token.trim() === '') {
    throw new Error('PUSH_GATEWAY=expo requires EXPO_ACCESS_TOKEN');
  }
  return new ExpoPushGateway(token.trim(), EXPO_PUSH_URL, parsePushHttpTimeoutMs(env.PUSH_HTTP_TIMEOUT_MS));
}
