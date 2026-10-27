/**
 * Story 5-2a (A13) — the guarded webhook transport under Bun (production runs
 * Bun; jest runs Node). `bun run webhooks:smoke` (or `bun
 * scripts/webhook-transport-smoke.ts`) starts local TLS servers with the
 * test CA in `test/fixtures/webhook-tls` and proves, under THIS runtime:
 *
 *  1. the pinned-IP connect: the host resolves (an injected resolver) to the
 *     loopback server, the request reaches it with the hostname in `Host` and
 *     SNI, the certificate is checked against the HOSTNAME, and the body and
 *     a verifiable signature arrive — with HTTPS_PROXY pointing nowhere;
 *  2. a private address is refused (`target-blocked`) with NO connection made;
 *  3. a mixed answer (public + private) is refused the same way;
 *  4. a redirect is not followed (the 302 is the outcome; one request only);
 *  5. a certificate from another CA is `tls-cert`, and no request reaches the handler.
 *
 * Exits 0 when every case holds, 1 otherwise.
 */
import { createServer, type Server } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';
import { GuardedHttpsTransport } from '../src/modules/client-webhooks/webhook-http';
import { webhookHeaders } from '../src/modules/client-webhooks/webhook-signature';
import { signingKeyOf } from '../src/modules/client-webhooks/webhook-secrets';

const FIXTURES = join(import.meta.dir, '..', 'test', 'fixtures', 'webhook-tls');
const ca = readFileSync(join(FIXTURES, 'ca.pem'));
const HOST = 'hooks.example.test';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

interface Seen {
  connections: number;
  requests: { host: string | undefined; url: string | undefined; body: string; headers: Record<string, string | string[] | undefined> }[];
}

function serve(certFile: string, keyFile: string, status: number): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = { connections: 0, requests: [] };
  const server = createServer({ cert: readFileSync(join(FIXTURES, certFile)), key: readFileSync(join(FIXTURES, keyFile)) }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.requests.push({ host: req.headers.host, url: req.url, body, headers: req.headers });
      res.writeHead(status, status === 302 ? { location: 'https://169.254.170.2/latest' } : {});
      res.end('ok');
    });
  });
  server.on('connection', () => (seen.connections += 1));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, seen })));
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}\n`);
  if (!ok) failures.push(name);
}

process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
process.env.https_proxy = 'http://127.0.0.1:9';

const good = await serve('hooks.pem', 'hooks.key', 204);
const redirect = await serve('hooks.pem', 'hooks.key', 302);
const rogue = await serve('rogue.pem', 'rogue.key', 200);
const loopback = async () => [{ address: '127.0.0.1', family: 4 as const }];
const body = JSON.stringify({ id: 'msg_smoke', type: 'webhook.test', data: { ok: true } });
const headers = webhookHeaders([signingKeyOf(SECRET)], 'msg_smoke', Math.floor(Date.now() / 1000), body);
const transport = (trusted: readonly string[], resolver = loopback) =>
  new GuardedHttpsTransport({ timeoutMs: 5000, denyHosts: [], resolver, ca, trustedTestAddresses: trusted });

process.stdout.write(`runtime: ${typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`}\n`);

// 1. the pinned-IP connect
{
  const outcome = await transport(['127.0.0.1']).post(`https://${HOST}:${good.port}/wms?x=1`, headers, body);
  const request = good.seen.requests[0];
  let verified = false;
  try {
    new Webhook(SECRET).verify(request?.body ?? '', request?.headers as Record<string, string>);
    verified = true;
  } catch {
    verified = false;
  }
  check(
    'pinned-IP connect (Host, SNI, hostname certificate check, body, signature)',
    outcome.kind === 'response' && outcome.statusCode === 204 && request?.host === `${HOST}:${good.port}` && request.url === '/wms?x=1' && request.body === body && verified,
    JSON.stringify({ outcome, host: request?.host, url: request?.url, verified }),
  );
}
// 2. a private address
{
  const before = good.seen.connections;
  const outcome = await transport([]).post(`https://${HOST}:${good.port}/wms`, headers, body);
  check('private address refused before any connection', outcome.kind === 'error' && outcome.code === 'target-blocked' && good.seen.connections === before, JSON.stringify(outcome));
}
// 3. a mixed answer
{
  const before = good.seen.connections;
  const outcome = await transport([], async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]).post(`https://${HOST}:${good.port}/wms`, headers, body);
  check('public + private answer refused', outcome.kind === 'error' && outcome.code === 'target-blocked' && good.seen.connections === before, JSON.stringify(outcome));
}
// 4. a redirect
{
  const outcome = await transport(['127.0.0.1']).post(`https://${HOST}:${redirect.port}/wms`, headers, body);
  check('redirect not followed', outcome.kind === 'response' && outcome.statusCode === 302 && redirect.seen.requests.length === 1, JSON.stringify(outcome));
}
// 5. a certificate from another CA
{
  const outcome = await transport(['127.0.0.1']).post(`https://${HOST}:${rogue.port}/wms`, headers, body);
  check('foreign certificate is tls-cert, no request', outcome.kind === 'error' && outcome.code === 'tls-cert' && rogue.seen.requests.length === 0, JSON.stringify(outcome));
}

for (const { server } of [good, redirect, rogue]) server.close();
if (failures.length > 0) {
  console.error(`webhook transport smoke: ${failures.length} case(s) failed`);
  process.exit(1);
}
process.stdout.write('webhook transport smoke: every case holds\n');
process.exit(0);
