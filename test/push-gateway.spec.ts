import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  EXPO_PUSH_URL,
  ExpoPushGateway,
  UnconfiguredPushGateway,
  parsePushHttpTimeoutMs,
  pushGatewayFromEnv,
  type PushMessage,
} from '../src/modules/notifications/push-gateway';
import {
  PUSH_COPY,
  PUSH_ERROR_CLASS,
  boundedCode,
  classifyPushCode,
  pushBackoffMs,
  pushCopyFor,
} from '../src/modules/notifications/push-rules';

/**
 * Story 9-2b — the `PushGateway` port against a local HTTPS stub (the
 * channel transports' discipline: one self-signed cert minted per run in the
 * OS temp dir, never committed; the process trusts it for these requests
 * only), plus the pure classification and copy tables. No database.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

type Answer = { status: number; body: unknown } | 'hang' | ((messages: PushMessage[]) => { status: number; body: unknown });

class ExpoStub {
  static key = '';
  static cert = '';
  static dir = '';
  readonly requests: Captured[] = [];
  private readonly server: https.Server;

  constructor(private readonly answer: Answer) {
    this.server = https.createServer({ key: ExpoStub.key, cert: ExpoStub.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (this.answer === 'hang') return; // never answers — the timeout arm
        const resolved = typeof this.answer === 'function' ? this.answer(JSON.parse(body) as PushMessage[]) : this.answer;
        res.writeHead(resolved.status, { 'content-type': 'application/json' });
        res.end(typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body));
      });
    });
  }

  static mint(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-expo-stub-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    );
    ExpoStub.key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    ExpoStub.cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    ExpoStub.dir = dir;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as { port: number }).port;
    return `https://127.0.0.1:${port}/--/api/v2/push/send`;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}

function message(i: number): PushMessage {
  return {
    to: `ExponentPushToken[token-${i}]`,
    title: 'New work ready',
    body: 'Picks released in your warehouse',
    data: { kind: 'new-work', tab: 'Pick' },
    ttl: 3600,
    channelId: 'work',
    priority: 'high',
  };
}

beforeAll(() => ExpoStub.mint());
afterAll(() => {
  fs.rmSync(ExpoStub.dir, { recursive: true, force: true });
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

describe('push gateway — Expo adapter against a stubbed https server (story 9-2b)', () => {
  async function withStub<T>(answer: Answer, run: (gateway: ExpoPushGateway, stub: ExpoStub) => Promise<T>, timeoutMs = 2_000): Promise<T> {
    const stub = new ExpoStub(answer);
    const url = await stub.start();
    try {
      return await run(new ExpoPushGateway('expo-access-token-xyz', url, timeoutMs), stub);
    } finally {
      stub.close();
    }
  }

  it('a batch of 100 is ONE POST carrying the 100 messages verbatim, Bearer-authenticated; the tickets come back in input order', async () => {
    const messages = Array.from({ length: 100 }, (_, i) => message(i));
    const tickets = await withStub(
      (sent) => ({
        status: 200,
        body: {
          data: sent.map((m, i) =>
            i === 41
              ? { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } }
              : i === 77
                ? { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }
                : { status: 'ok', id: `ticket-${i}` },
          ),
        },
      }),
      async (gateway, stub) => {
        const result = await gateway.send(messages);
        expect(stub.requests).toHaveLength(1);
        const [req] = stub.requests;
        expect(req!.method).toBe('POST');
        expect(req!.url).toBe('/--/api/v2/push/send');
        expect(req!.headers.authorization).toBe('Bearer expo-access-token-xyz');
        expect(req!.headers['content-type']).toBe('application/json');
        expect(JSON.parse(req!.body)).toEqual(messages);
        return result;
      },
    );
    expect(tickets).toHaveLength(100);
    expect(tickets[41]).toEqual({ ok: false, code: 'DeviceNotRegistered' });
    expect(tickets[77]).toEqual({ ok: false, code: 'MessageTooBig' });
    expect(tickets.filter((t) => t.ok)).toHaveLength(98);
    // Only the CODE crosses the port — never Expo's message (it names the token).
    expect(JSON.stringify(tickets)).not.toContain('ExponentPushToken');
  });

  it('every ticket error class comes back as its code; a ticket without details is unknown-error', async () => {
    const codes = ['DeviceNotRegistered', 'MessageTooBig', 'InvalidProviderToken', 'MessageRateExceeded', 'InvalidCredentials'];
    const tickets = await withStub(
      {
        status: 200,
        body: {
          data: [
            ...codes.map((error) => ({ status: 'error', message: 'x', details: { error } })),
            { status: 'error', message: 'no details' },
            { status: 'ok', id: 'a' },
          ],
        },
      },
      (gateway) => gateway.send(Array.from({ length: codes.length + 2 }, (_, i) => message(i))),
    );
    expect(tickets).toEqual([...codes.map((code) => ({ ok: false, code })), { ok: false, code: 'unknown-error' }, { ok: true }]);
    expect(codes.map((code) => classifyPushCode(code))).toEqual(['permanent', 'permanent', 'permanent', 'transient', 'config']);
  });

  it('whole-request outcomes apply to every message: 503 / 429 transient, 401 / 403 config, any other 4xx permanent', async () => {
    for (const [status, cls] of [
      [503, 'transient'],
      [500, 'transient'],
      [429, 'transient'],
      [401, 'config'],
      [403, 'config'],
      [400, 'permanent'],
      [413, 'permanent'],
    ] as const) {
      const tickets = await withStub({ status, body: { errors: [{ code: 'X', message: 'ExponentPushToken[leak]' }] } }, (gateway) =>
        gateway.send([message(1), message(2)]),
      );
      expect(tickets).toEqual([
        { ok: false, code: `http-${status}` },
        { ok: false, code: `http-${status}` },
      ]);
      expect(classifyPushCode(`http-${status}`)).toBe(cls);
    }
  });

  it('a malformed 2xx — not JSON, or not one ticket per message — is bad-response for the whole batch (permanent: never retried blind)', async () => {
    expect(await withStub({ status: 200, body: 'not json{' }, (g) => g.send([message(1)]))).toEqual([{ ok: false, code: 'bad-response' }]);
    expect(await withStub({ status: 200, body: { data: [{ status: 'ok' }] } }, (g) => g.send([message(1), message(2)]))).toEqual([
      { ok: false, code: 'bad-response' },
      { ok: false, code: 'bad-response' },
    ]);
    expect(classifyPushCode('bad-response')).toBe('permanent');
  });

  it('a hung server is a timeout; an unreachable one is network — both transient, and the port never throws', async () => {
    const timedOut = await withStub('hang', (g) => g.send([message(1)]), 300);
    expect(timedOut).toEqual([{ ok: false, code: 'timeout' }]);
    const closed = new ExpoPushGateway('t', 'https://127.0.0.1:1/--/api/v2/push/send', 1_000);
    expect(await closed.send([message(1)])).toEqual([{ ok: false, code: 'network' }]);
    expect(classifyPushCode('timeout')).toBe('transient');
    expect(classifyPushCode('network')).toBe('transient');
  });

  it('refuses a non-https URL and a batch over 100; an empty batch makes no call', async () => {
    expect(() => new ExpoPushGateway('t', 'http://exp.host/--/api/v2/push/send')).toThrow(/https/);
    await withStub({ status: 200, body: { data: [] } }, async (gateway, stub) => {
      expect(await gateway.send([])).toEqual([]);
      expect(stub.requests).toHaveLength(0);
      await expect(gateway.send(Array.from({ length: 101 }, (_, i) => message(i)))).rejects.toThrow(/at most 100/);
    });
  });
});

describe('push gateway selection (story 9-2b)', () => {
  it('unset or `unconfigured` is the recording no-op; `expo` needs EXPO_ACCESS_TOKEN; anything else fails the boot', async () => {
    expect(pushGatewayFromEnv({}).mode).toBe('unconfigured');
    expect(pushGatewayFromEnv({ PUSH_GATEWAY: '' }).mode).toBe('unconfigured');
    expect(pushGatewayFromEnv({ PUSH_GATEWAY: 'unconfigured' }).mode).toBe('unconfigured');
    expect(() => pushGatewayFromEnv({ PUSH_GATEWAY: 'expo' })).toThrow('PUSH_GATEWAY=expo requires EXPO_ACCESS_TOKEN');
    expect(() => pushGatewayFromEnv({ PUSH_GATEWAY: 'expo', EXPO_ACCESS_TOKEN: '  ' })).toThrow('requires EXPO_ACCESS_TOKEN');
    expect(pushGatewayFromEnv({ PUSH_GATEWAY: 'expo', EXPO_ACCESS_TOKEN: 'tok' }).mode).toBe('expo');
    expect(() => pushGatewayFromEnv({ PUSH_GATEWAY: 'fcm' })).toThrow(/PUSH_GATEWAY must be one of unconfigured, expo/);
    expect(() => pushGatewayFromEnv({ PUSH_GATEWAY: 'expo', EXPO_ACCESS_TOKEN: 'tok', PUSH_HTTP_TIMEOUT_MS: '0' })).toThrow(/PUSH_HTTP_TIMEOUT_MS/);
    expect(parsePushHttpTimeoutMs(undefined)).toBe(10_000);
    expect(parsePushHttpTimeoutMs('2500')).toBe(2_500);
    expect(EXPO_PUSH_URL).toBe('https://exp.host/--/api/v2/push/send');

    const unconfigured = new UnconfiguredPushGateway();
    expect(await unconfigured.send([message(1), message(2)])).toEqual([{ ok: true }, { ok: true }]);
    expect(unconfigured.recorded).toEqual([message(1), message(2)]);
  });
});

describe('push rules — the classification table, the backoff and the copy (story 9-2b)', () => {
  it('PUSH_ERROR_CLASS is the one table; unknown codes and unlisted 4xx are permanent, any 5xx transient', () => {
    expect(PUSH_ERROR_CLASS).toEqual({
      DeviceNotRegistered: 'permanent',
      MessageTooBig: 'permanent',
      InvalidProviderToken: 'permanent',
      MessageRateExceeded: 'transient',
      network: 'transient',
      timeout: 'transient',
      'http-429': 'transient',
      'http-401': 'config',
      'http-403': 'config',
      InvalidCredentials: 'config',
    });
    expect(classifyPushCode('SomethingNew')).toBe('permanent');
    expect(classifyPushCode('http-404')).toBe('permanent');
    expect(classifyPushCode('http-502')).toBe('transient');
    expect(boundedCode('Device Not"Registered<script>')).toBe('DeviceNotRegisteredscript');
    expect(boundedCode('')).toBe('unknown');
  });

  it('the backoff is min(2^(attempts-1) · 5 s, 5 min)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(pushBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  });

  it('the copy is fixed per kind (new-work per tab), and new-work has no All arm', () => {
    expect(PUSH_COPY).toEqual({
      'new-work': {
        Pick: { title: 'New work ready', body: 'Picks released in your warehouse' },
        Count: { title: 'New work ready', body: 'A count was created' },
        Transfer: { title: 'New work ready', body: 'An inbound transfer is on its way' },
      },
      approval: { title: 'Approval waiting', body: 'Decide it on the web' },
      'at-risk': { title: 'Wave cutoff in under an hour', body: "A planned wave isn't released yet" },
    });
    expect(pushCopyFor('new-work', 'All')).toBeNull();
    expect(pushCopyFor('approval', 'All')).toEqual(PUSH_COPY.approval);
    expect(pushCopyFor('at-risk', 'All')).toEqual(PUSH_COPY['at-risk']);
  });
});
