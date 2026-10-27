import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import net, { BlockList, type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { GuardedHttpsTransport, isPublicAddress, transportCodeOf, type WebhookResolver } from './webhook-http';

/**
 * Story 5-2a (decision 11, A13–A15) — the guarded transport on Node (jest);
 * `scripts/webhook-transport-smoke.ts` proves the same under Bun. Local TLS
 * servers carry certificates from the test CA in `test/fixtures/webhook-tls`
 * (`hooks.example.test`), and a rogue self-signed one.
 */
const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'webhook-tls');
const ca = readFileSync(join(FIXTURES, 'ca.pem'));
const HOST = 'hooks.example.test';

interface Seen {
  connections: number;
  requests: { host: string | undefined; body: string }[];
}

async function serve(certFile: string, keyFile: string, handler: (res: ServerResponse) => void): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { connections: 0, requests: [] };
  const server = createServer({ cert: readFileSync(join(FIXTURES, certFile)), key: readFileSync(join(FIXTURES, keyFile)) }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.requests.push({ host: req.headers.host, body });
      handler(res);
    });
  });
  server.on('connection', () => (seen.connections += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const loopback: WebhookResolver = async () => [{ address: '127.0.0.1', family: 4 }];
const trusted = (resolver: WebhookResolver = loopback, timeoutMs = 3000) =>
  new GuardedHttpsTransport({ timeoutMs, denyHosts: ['api.wms.example'], resolver, ca, trustedTestAddresses: ['127.0.0.1'] });
const guarded = (resolver: WebhookResolver, extraDeny?: BlockList) =>
  new GuardedHttpsTransport({ timeoutMs: 3000, denyHosts: [], resolver, ca, ...(extraDeny === undefined ? {} : { extraDeny }) });

describe('the guarded webhook transport (story 5-2a)', () => {
  let ok: { server: Server; port: number; seen: Seen };
  let rogue: { server: Server; port: number; seen: Seen };
  let redirect: { server: Server; port: number; seen: Seen };
  let big: { server: Server; port: number; seen: Seen };
  let hang: { server: Server; port: number; seen: Seen };
  let limited: { server: Server; port: number; seen: Seen };
  let heldOpen: { server: Server; port: number; seen: Seen };
  let closed = 0;

  beforeAll(async () => {
    ok = await serve('hooks.pem', 'hooks.key', (res) => res.writeHead(204).end());
    rogue = await serve('rogue.pem', 'rogue.key', (res) => res.writeHead(200).end('no'));
    redirect = await serve('hooks.pem', 'hooks.key', (res) => res.writeHead(302, { location: 'https://169.254.170.2/' }).end());
    big = await serve('hooks.pem', 'hooks.key', (res) => {
      res.writeHead(500);
      res.write('x'.repeat(64 * 1024));
      // never ends — the transport stops reading at 4 KiB
    });
    hang = await serve('hooks.pem', 'hooks.key', () => undefined);
    limited = await serve('hooks.pem', 'hooks.key', (res) => res.writeHead(429, { 'retry-after': '120' }).end());
    // A 200 whose body is never finished (C7).
    heldOpen = await serve('hooks.pem', 'hooks.key', (res) => {
      res.writeHead(200);
      res.write('ok');
    });
    hang.server.on('connection', (socket) => socket.on('close', () => (closed += 1)));
  });

  afterAll(async () => {
    for (const { server } of [ok, rogue, redirect, big, hang, limited, heldOpen]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('connects to the validated IP with the hostname in Host and SNI, and the certificate checked against the hostname', async () => {
    const outcome = await trusted().post(`https://${HOST}:${ok.port}/wms`, { 'content-type': 'application/json' }, '{"a":1}');
    expect(outcome).toMatchObject({ kind: 'response', statusCode: 204 });
    expect(ok.seen.requests.at(-1)).toEqual({ host: `${HOST}:${ok.port}`, body: '{"a":1}' });
  });

  it('SSRF: an address outside the allowlist is refused with ZERO tls.connect / net.connect calls', async () => {
    const tlsConnect = jest.spyOn(tls, 'connect');
    const netConnect = jest.spyOn(net, 'connect');
    for (const resolver of [
      async () => [{ address: '169.254.170.2', family: 4 as const }],
      async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }],
      async () => [{ address: '::ffff:10.0.0.1', family: 6 as const }],
      async () => [{ address: '64:ff9b::a00:1', family: 6 as const }],
      async () => [{ address: 'fd00:ec2::254', family: 6 as const }],
    ]) {
      const outcome = await guarded(resolver).post(`https://${HOST}:${ok.port}/wms`, {}, '{}');
      expect(outcome).toMatchObject({ kind: 'error', code: 'target-blocked' });
    }
    expect(tlsConnect).not.toHaveBeenCalled();
    expect(netConnect).not.toHaveBeenCalled();
  });

  it('WEBHOOK_DENY_CIDRS adds to the denylist', async () => {
    const deny = new BlockList();
    deny.addSubnet('93.184.216.0', 24, 'ipv4');
    const outcome = await guarded(async () => [{ address: '93.184.216.34', family: 4 }], deny).post(`https://${HOST}/wms`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'error', code: 'target-blocked' });
  });

  it('a deny-listed host and an IP-literal URL are refused at send too (a stored row is never trusted)', async () => {
    expect(await trusted().post('https://api.wms.example/hook', {}, '{}')).toMatchObject({ kind: 'error', code: 'target-blocked' });
    expect(await trusted().post(`https://127.0.0.1:${ok.port}/`, {}, '{}')).toMatchObject({ kind: 'error', code: 'target-blocked' });
    expect(await trusted().post(`http://${HOST}:${ok.port}/`, {}, '{}')).toMatchObject({ kind: 'error', code: 'target-blocked' });
  });

  it('an empty or failing resolution is dns-failed', async () => {
    expect(await guarded(async () => []).post(`https://${HOST}/`, {}, '{}')).toMatchObject({ kind: 'error', code: 'dns-failed' });
    expect(
      await guarded(async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      }).post(`https://${HOST}/`, {}, '{}'),
    ).toMatchObject({ kind: 'error', code: 'dns-failed' });
  });

  it('a socket that connects somewhere it was not sent is destroyed before TLS (target-blocked)', async () => {
    // The socket reports a peer other than the address the transport chose.
    const realConnect = tls.connect.bind(tls) as (...args: unknown[]) => tls.TLSSocket;
    jest.spyOn(tls, 'connect').mockImplementation(((...args: unknown[]) => {
      const socket = realConnect(...args);
      Object.defineProperty(socket, 'remoteAddress', { get: () => '10.9.9.9' });
      return socket;
    }) as typeof tls.connect);
    const before = ok.seen.requests.length;
    const outcome = await trusted().post(`https://${HOST}:${ok.port}/wms`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'error', code: 'target-blocked' });
    expect(ok.seen.requests.length).toBe(before);
  });

  it('a certificate from another CA (or self-signed) is tls-cert, and no request body is written (A15)', async () => {
    const outcome = await trusted().post(`https://${HOST}:${rogue.port}/wms`, {}, '{"secret-ish":1}');
    expect(outcome).toMatchObject({ kind: 'error', code: 'tls-cert' });
    expect(rogue.seen.requests).toHaveLength(0);
  });

  it('without the test CA the system store refuses the test certificate (no opt-out)', async () => {
    const outcome = await new GuardedHttpsTransport({ timeoutMs: 3000, denyHosts: [], resolver: loopback, trustedTestAddresses: ['127.0.0.1'] }).post(
      `https://${HOST}:${ok.port}/`,
      {},
      '{}',
    );
    expect(outcome).toMatchObject({ kind: 'error', code: 'tls-cert' });
  });

  it('a redirect is not followed — the 3xx is the outcome, one request', async () => {
    const outcome = await trusted().post(`https://${HOST}:${redirect.port}/wms`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'response', statusCode: 302 });
    expect(redirect.seen.requests).toHaveLength(1);
  });

  it('reads at most 4 KiB of a response, then stops (a never-ending body does not hang the send)', async () => {
    const started = Date.now();
    const outcome = await trusted(loopback, 2500).post(`https://${HOST}:${big.port}/`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'response', statusCode: 500 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a receiver that never answers times out inside the total timeout', async () => {
    const outcome = await trusted(loopback, 400).post(`https://${HOST}:${hang.port}/`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'error', code: 'timeout' });
    expect(outcome.durationMs).toBeLessThan(2000);
  });

  it('C7: a 200 whose body is held open is a 200 at once, never a timeout', async () => {
    const started = Date.now();
    const outcome = await trusted(loopback, 2000).post(`https://${HOST}:${heldOpen.port}/`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'response', statusCode: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('C6: the total timeout destroys the socket — no connection outlives the reported timeout', async () => {
    const before = closed;
    expect(await trusted(loopback, 300).post(`https://${HOST}:${hang.port}/`, {}, '{}')).toMatchObject({ kind: 'error', code: 'timeout' });
    const deadline = Date.now() + 2000;
    while (closed === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBeGreaterThan(before);
  });

  it('C8: an IPv4 address is preferred over an AAAA answered first (every address still validated)', async () => {
    const dual: WebhookResolver = async () => [
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ];
    const transport = new GuardedHttpsTransport({ timeoutMs: 3000, denyHosts: [], resolver: dual, ca, trustedTestAddresses: ['127.0.0.1', '::1'] });
    expect(await transport.post(`https://${HOST}:${ok.port}/`, {}, '{}')).toMatchObject({ kind: 'response', statusCode: 204 });
    // …and a mixed answer is still refused when the IPv6 one is not allowed.
    const strict = new GuardedHttpsTransport({ timeoutMs: 3000, denyHosts: [], resolver: dual, ca, trustedTestAddresses: ['127.0.0.1'] });
    expect(await strict.post(`https://${HOST}:${ok.port}/`, {}, '{}')).toMatchObject({ kind: 'error', code: 'target-blocked' });
  });

  it('Retry-After is read', async () => {
    const outcome = await trusted().post(`https://${HOST}:${limited.port}/`, {}, '{}');
    expect(outcome).toMatchObject({ kind: 'response', statusCode: 429, retryAfterMs: 120_000 });
  });

  it('the address allowlist (A14)', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2a00:1450::1']) expect(isPublicAddress(address)).toBe(true);
    for (const address of [
      '0.1.2.3', '10.1.1.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '169.254.170.2', '172.16.0.1', '172.31.255.255',
      '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::1', '::', '::ffff:8.8.8.8', '64:ff9b::808:808', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1',
      '2001:db8::1', '2002::1', '2001::1', '2001:1ff::1', '3fff::1', 'not-an-ip',
    ]) {
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });

  it('error codes map to the bounded vocabulary', () => {
    expect(transportCodeOf({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe('tls-cert');
    expect(transportCodeOf({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('tls-cert');
    expect(transportCodeOf({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).toBe('tls-handshake');
    expect(transportCodeOf({ code: 'ECONNREFUSED' })).toBe('network');
    expect(transportCodeOf({ code: 'EAI_AGAIN' })).toBe('dns-failed');
  });
});
