import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { BlockList, isIP, type Socket } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import {
  WEBHOOK_RESPONSE_READ_BYTES,
  isDeniedHost,
  parseRetryAfterMs,
  type WebhookSendOutcome,
  type WebhookTransportCode,
} from './webhook-rules';

/**
 * Story 5-2a (decision 11 as amended by A13, A14, A15) — THE ONLY FILE THAT
 * OPENS A SOCKET TO A CLIENT URL (pinned by `test/architecture.spec.ts`).
 * Fail-closed SSRF protection at every send:
 *
 *  1. **Resolve, then validate every address.** The host is resolved (all
 *     addresses, `verbatim`), and the send is refused `target-blocked` if
 *     ANY address is outside the public allowlist: IPv4 public unicast, IPv6
 *     inside `2000::/3` minus the documentation, 6to4, Teredo/ORCHID and
 *     `3fff::/20` ranges — so loopback, RFC 1918, CGNAT, link-local (the ECS
 *     task metadata endpoint `169.254.170.2` among them), mapped, NAT64
 *     (`64:ff9b::/96`, where a DNS64 resolver could embed a private IPv4),
 *     ULA and multicast are all refused — plus `WEBHOOK_DENY_CIDRS`.
 *  2. **Connect to the validated IP itself** (`host` = the address; the
 *     hostname rides SNI, the `Host` header and an explicit
 *     `checkServerIdentity`), so a DNS answer that changes between the check
 *     and the connect (rebinding) cannot redirect the socket. No `lookup`
 *     happens inside `https.request`. Proven identical under Node (jest) and
 *     Bun (`scripts/webhook-transport-smoke.ts`, A13).
 *  3. **Re-check on connect:** the socket's `remoteAddress` must be the
 *     address chosen, else it is destroyed before any TLS byte (`target-blocked`).
 *  4. **Transport rules:** `agent: false` (no pooled socket, no proxy — the
 *     proxy env vars are never read), redirects are never followed (the
 *     caller classifies a 3xx), `rejectUnauthorized: true` with no opt-out,
 *     TLS ≥ 1.2, the system CA store, no client certificate; one total
 *     timeout over resolve + connect + response; at most 4 KiB of the
 *     response is read, then the socket is destroyed.
 *
 * Logs nothing: the outcome is a code (`WebhookTransportCode`) or a status,
 * never an address, a header or a body. The resolver and the CA are
 * injectable for the suites (a local TLS server); production passes neither.
 */

/** One resolved address. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a host to every address it has (the default is the system resolver). */
export type WebhookResolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export interface WebhookTransportOptions {
  readonly timeoutMs: number;
  /** The deployment's own hostnames (`WEBHOOK_DENY_HOSTS`), refused at send too. */
  readonly denyHosts: readonly string[];
  /** `WEBHOOK_DENY_CIDRS`, beside the built-in ranges. */
  readonly extraDeny?: BlockList;
  readonly resolver?: WebhookResolver;
  /** TEST ONLY: trust this CA instead of the system store (a suite's local TLS server). */
  readonly ca?: string | Buffer;
  /**
   * TEST ONLY: exact addresses exempt from the allowlist (a suite's loopback
   * TLS server). Set only in code by the transport spec and the Bun smoke —
   * never from the environment, never per tenant (`test/architecture.spec.ts`
   * pins that no other source file names it).
   */
  readonly trustedTestAddresses?: readonly string[];
}

/** The port the sender and the test send use (a fake replaces it in the suites). */
export interface WebhookTransport {
  post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<WebhookSendOutcome>;
}

export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

// ── the address allowlist ────────────────────────────────────────────────

/** IPv4 ranges that are never a public receiver (A14). */
const DENIED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** IPv6 ranges refused INSIDE the global-unicast `2000::/3` (A14). */
const DENIED_V6: readonly [string, number][] = [
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2001::', 23],
  ['3fff::', 20],
];

const deniedV4 = new BlockList();
for (const [address, prefix] of DENIED_V4) deniedV4.addSubnet(address, prefix, 'ipv4');
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [address, prefix] of DENIED_V6) deniedV6.addSubnet(address, prefix, 'ipv6');

/** True when `address` is a public unicast address a webhook may reach (before `WEBHOOK_DENY_CIDRS`). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, 'ipv4');
  if (family === 6) {
    // Zone ids (`fe80::1%eth0`) never reach here as public: strip and judge.
    const bare = address.split('%')[0]!;
    return globalUnicastV6.check(bare, 'ipv6') && !deniedV6.check(bare, 'ipv6');
  }
  return false;
}

function allowed(address: string, extraDeny: BlockList | undefined): boolean {
  if (!isPublicAddress(address)) return false;
  if (extraDeny === undefined) return true;
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  return !extraDeny.check(address.split('%')[0]!, family);
}

const systemResolver: WebhookResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));

// ── error classification ─────────────────────────────────────────────────

class TransportFailure extends Error {
  constructor(readonly code: WebhookTransportCode) {
    super(code);
    this.name = 'TransportFailure';
  }
}

const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

/** A socket / TLS / DNS error → one transport code (never its message). */
export function transportCodeOf(err: unknown): WebhookTransportCode {
  if (err instanceof TransportFailure) return err.code;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  if (CERT_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS_CERT')) return 'tls-cert';
  if (code.startsWith('ERR_SSL') || code === 'EPROTO' || code.startsWith('ERR_TLS')) return 'tls-handshake';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA' || code === 'EAI_NONAME' || code === 'ENODATA') return 'dns-failed';
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return 'timeout';
  return 'network';
}

// ── the transport ────────────────────────────────────────────────────────

/** The guarded HTTPS transport — the only `WebhookTransport` that touches the network. */
export class GuardedHttpsTransport implements WebhookTransport {
  constructor(private readonly options: WebhookTransportOptions) {}

  async post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<WebhookSendOutcome> {
    const started = Date.now();
    const elapsed = () => Math.max(0, Date.now() - started);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: 'error', code: 'target-blocked', durationMs: elapsed() };
    }
    const hostname = parsed.hostname.replace(/\.$/, '');
    // Belt and braces: the save-time rules ran when the URL was stored, but
    // the deny list may have grown since, and a stored row is never trusted.
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || isIP(hostname) !== 0 || hostname.startsWith('[') || isDeniedHost(hostname, this.options.denyHosts)) {
      return { kind: 'error', code: 'target-blocked', durationMs: elapsed() };
    }
    const port = parsed.port === '' ? 443 : Number(parsed.port);
    // Code review C6 — ONE total deadline over resolve + connect + response:
    // when it fires, the in-flight request (if any) is DESTROYED, so a
    // trickling receiver can never hold a socket past the reported timeout.
    const inFlight: { request: ClientRequest | null } = { request: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = new TransportFailure('timeout');
        inFlight.request?.destroy(failure);
        reject(failure);
      }, this.options.timeoutMs);
      timer.unref?.();
    });
    try {
      const resolved = await Promise.race([this.resolve(hostname), timeout]);
      if (resolved.length === 0) return { kind: 'error', code: 'dns-failed', durationMs: elapsed() };
      const trusted = this.options.trustedTestAddresses ?? [];
      if (!resolved.every((entry) => trusted.includes(entry.address) || allowed(entry.address, this.options.extraDeny))) {
        return { kind: 'error', code: 'target-blocked', durationMs: elapsed() };
      }
      // Code review C8 — IPv4 first (stable within each family): an
      // IPv4-only egress (ECS without IPv6) must not fail every dual-stack
      // receiver on its AAAA record. Every address was validated above.
      const target = [...resolved].sort((a, b) => a.family - b.family)[0]!;
      const response = await Promise.race([this.request(target.address, hostname, port, parsed, headers, body, inFlight), timeout]);
      return { kind: 'response', statusCode: response.statusCode, retryAfterMs: response.retryAfterMs, durationMs: elapsed() };
    } catch (err) {
      return { kind: 'error', code: transportCodeOf(err), durationMs: elapsed() };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Whatever happened, the socket goes: no keep-alive, no lingering read.
      inFlight.request?.destroy();
    }
  }

  private async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    try {
      return await (this.options.resolver ?? systemResolver)(hostname);
    } catch (err) {
      const code = transportCodeOf(err);
      throw new TransportFailure(code === 'network' ? 'dns-failed' : code);
    }
  }

  private request(
    address: string,
    hostname: string,
    port: number,
    url: URL,
    headers: Readonly<Record<string, string>>,
    body: string,
    inFlight: { request: ClientRequest | null },
  ): Promise<{ statusCode: number; retryAfterMs: number | null }> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(body, 'utf8');
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const request = https.request(
        {
          host: address,
          port,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          servername: hostname,
          // The identity is the HOSTNAME's, never the pinned IP's.
          checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
          // No pooled socket, no proxy. (No `autoSelectFamily`: the host is
          // already one validated IP, so there is no family to race.)
          agent: false,
          headers: {
            ...headers,
            host: port === 443 ? hostname : `${hostname}:${port}`,
            'content-length': String(payload.length),
          },
        },
        (response: IncomingMessage) => {
          // Code review C7 — the STATUS is the outcome: settle on the
          // response head, never on the body's end (a receiver that answers
          // 200 and then holds the body open must not read as a timeout and
          // be re-sent). At most 4 KiB is then drained; the caller's finally
          // destroys the socket.
          if (!settled) {
            settled = true;
            resolve({
              statusCode: response.statusCode ?? 0,
              retryAfterMs: parseRetryAfterMs(firstHeader(response.headers['retry-after']), Date.now()),
            });
          }
          let read = 0;
          response.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read >= WEBHOOK_RESPONSE_READ_BYTES) response.destroy();
          });
          response.on('error', () => undefined);
        },
      );
      inFlight.request = request;
      request.on('socket', (socket: Socket) => {
        socket.once('connect', () => {
          if (socket.remoteAddress !== address) {
            const failure = new TransportFailure('target-blocked');
            fail(failure);
            socket.destroy(failure);
          }
        });
      });
      request.on('error', fail);
      request.end(payload);
    });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The production transport over the parsed config. */
export function guardedTransport(options: WebhookTransportOptions): WebhookTransport {
  return new GuardedHttpsTransport(options);
}
