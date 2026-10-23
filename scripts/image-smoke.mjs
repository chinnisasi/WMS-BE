/* global process, console, setTimeout, clearTimeout, Buffer, URL */
/**
 * Story 6-2c (decision 8, A2, A16, A20) — the in-image smokes. Plain ESM, so
 * Bun (wms-be) and Node (wms-fe) both run it. CI runs it as a CONTAINER on
 * the same docker network as the image under test (the image itself, with
 * this file mounted read-only), never on the runner's host network.
 *
 * The same file lives in wms-be and in wms-fe (`scripts/image-smoke.mjs`);
 * keep the two copies identical (PENDING, deploy — CI cannot see the other
 * repo, so nothing checks it).
 *
 *   image-smoke.mjs ready     <base> [--path=/api/v1/health]
 *   image-smoke.mjs status    <url> <status> [--contains=<text>]
 *   image-smoke.mjs keepalive <base> [--path=…] [--idle-ms=61000] [--timeout=65]
 *   image-smoke.mjs drain     <base> [--path=…] [--echo=/api/v1/echo]
 *   image-smoke.mjs web-drain <base> [--path=/runtime-config.js]
 *
 * keepalive  the response carries `Keep-Alive: timeout=<timeout>`, and a
 *            second request on the SAME socket after `idle-ms` idle answers
 *            200 (the ALB's 60 s idle reuse — the 502 race this story closes)
 * drain      (wms-be) an idle kept-alive socket and a POST with half its body
 *            are open; the script prints `SMOKE-SIGNAL-NOW` and CI sends
 *            SIGTERM; then: a NEW connection gets no 200; the idle socket is
 *            either closed cleanly before the request is accepted or answers
 *            200 with `Connection: close`; the rest of the body, sent 3 s
 *            after the signal, gets its 200 echo with `Connection: close`
 * web-drain  (wms-fe) a request in flight on a kept-alive socket at SIGTERM
 *            is answered with `Connection: close`
 *
 * A close is asserted by its kind (ECONNRESET, EPIPE, end of stream), never
 * by a timing guess. Every probe retries at most once, logged. Exit 0 = pass.
 */
import net from 'node:net';

const SIGNAL_MARKER = 'SMOKE-SIGNAL-NOW';

function log(line) {
  process.stdout.write(`[image-smoke] ${line}\n`);
}

function fail(message) {
  console.error(`[image-smoke] FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(args, name, fallback) {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * A raw HTTP/1.1 connection: requests are written by hand and responses
 * parsed here, so keep-alive reuse and closes are observed exactly (no
 * client pool in between).
 */
class Connection {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.buffer = Buffer.alloc(0);
    this.closed = null; // why the socket ended: 'end' | 'close' | an error code
    this.waiters = [];
  }

  open(connectTimeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      // A connect that never completes is destroyed with ETIMEDOUT; once
      // connected the timer is off (the keepalive mode idles 61 s on purpose).
      socket.setTimeout(connectTimeoutMs, () => {
        const error = new Error(`connect to ${this.host}:${this.port} timed out after ${connectTimeoutMs} ms`);
        error.code = 'ETIMEDOUT';
        socket.destroy(error);
      });
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(this);
      });
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.wake();
      });
      socket.on('end', () => this.end('end'));
      socket.on('close', () => this.end('close'));
      socket.on('error', (error) => {
        this.end(error.code ?? 'error');
        reject(error);
      });
    });
  }

  end(reason) {
    if (this.closed === null) this.closed = reason;
    this.wake();
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  changed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  write(text) {
    return new Promise((resolve) => {
      if (this.closed !== null || this.socket.destroyed) return resolve(this.closed ?? 'destroyed');
      this.socket.write(text, (error) => resolve(error ? (error.code ?? 'error') : null));
    });
  }

  /** Waits for one full response; resolves {status, headers, body} or {closed: reason}. */
  async response(ms = 30_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const parsed = parseResponse(this.buffer);
      if (parsed !== null) {
        this.buffer = this.buffer.subarray(parsed.length);
        return parsed;
      }
      if (this.closed !== null) return { closed: this.closed, partial: this.buffer.length };
      const left = deadline - Date.now();
      if (left <= 0) return { closed: 'timeout', partial: this.buffer.length };
      await this.changed(left);
    }
  }

  destroy() {
    this.socket?.destroy();
  }
}

function parseResponse(buffer) {
  const headEnd = buffer.indexOf('\r\n\r\n');
  if (headEnd < 0) return null;
  const head = buffer.subarray(0, headEnd).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = {};
  for (const line of head.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  let offset = headEnd + 4;
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    const parts = [];
    for (;;) {
      const lineEnd = buffer.indexOf('\r\n', offset);
      if (lineEnd < 0) return null;
      const size = parseInt(buffer.subarray(offset, lineEnd).toString('latin1'), 16);
      if (Number.isNaN(size)) return null;
      if (size === 0) {
        const trailerEnd = buffer.indexOf('\r\n\r\n', lineEnd);
        if (trailerEnd < 0 && buffer.length < lineEnd + 4) return null;
        const end = trailerEnd >= 0 ? trailerEnd + 4 : lineEnd + 4;
        return { status, headers, body: Buffer.concat(parts).toString('utf8'), length: end };
      }
      if (buffer.length < lineEnd + 2 + size + 2) return null;
      parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
      offset = lineEnd + 2 + size + 2;
    }
  }
  const length = Number(headers['content-length'] ?? 0);
  if (buffer.length < offset + length) return null;
  return { status, headers, body: buffer.subarray(offset, offset + length).toString('utf8'), length: offset + length };
}

function request(method, path, host, extra = {}, body = '') {
  const headers = { Host: host, Connection: 'keep-alive', ...extra };
  if (body !== '' || method === 'POST') headers['Content-Length'] = String(Buffer.byteLength(body));
  return `${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`;
}

function target(base) {
  const url = new URL(base);
  return { host: url.hostname, port: Number(url.port || 80), hostHeader: url.host };
}

/** One GET on a fresh connection; resolves the response or {closed}. */
async function getOnce(base, path, ms = 5_000) {
  const t = target(base);
  const connection = new Connection(t.host, t.port);
  try {
    await connection.open();
  } catch (error) {
    return { closed: error.code ?? 'error' };
  }
  await connection.write(request('GET', path, t.hostHeader, { Connection: 'close' }));
  const response = await connection.response(ms);
  connection.destroy();
  return response;
}

async function waitReady(base, path, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const response = await getOnce(base, path, 2_000);
    if (response.status === 200) {
      log(`ready: GET ${path} 200`);
      return;
    }
    if (Date.now() > deadline) fail(`not ready within ${ms} ms (last: ${JSON.stringify(response.closed ?? response.status)})`);
    await sleep(1_000);
  }
}

async function openKeptAlive(base, path) {
  const t = target(base);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const connection = new Connection(t.host, t.port);
    try {
      await connection.open();
      await connection.write(request('GET', path, t.hostHeader));
      const first = await connection.response(10_000);
      if (first.status === 200) return { connection, first };
      log(`first request attempt ${attempt}: ${JSON.stringify(first.closed ?? first.status)}`);
    } catch (error) {
      log(`first request attempt ${attempt}: ${error.code ?? error}`);
    }
    connection.destroy();
    if (attempt === 1) log('retrying once');
  }
  fail('the first keep-alive request never answered 200');
}

async function keepalive(base, args) {
  const path = option(args, 'path', '/api/v1/health');
  const idleMs = Number(option(args, 'idle-ms', '61000'));
  const timeout = option(args, 'timeout', '65');
  const t = target(base);
  await waitReady(base, path);
  const { connection, first } = await openKeptAlive(base, path);
  const keepAliveHeader = first.headers['keep-alive'] ?? '';
  log(`first response: ${first.status}, Keep-Alive: "${keepAliveHeader}", Connection: "${first.headers.connection ?? ''}"`);
  if (!new RegExp(`(^|[ ,])timeout=${timeout}($|[ ,])`).test(keepAliveHeader)) {
    fail(`expected Keep-Alive: timeout=${timeout}, got "${keepAliveHeader}"`);
  }
  log(`idling the socket ${idleMs} ms…`);
  await sleep(idleMs);
  if (connection.closed !== null) fail(`the server closed the idle socket before ${idleMs} ms (${connection.closed})`);
  const writeError = await connection.write(request('GET', path, t.hostHeader));
  const second = writeError === null ? await connection.response(10_000) : { closed: writeError };
  connection.destroy();
  if (second.status !== 200) fail(`the reused socket after ${idleMs} ms idle: ${JSON.stringify(second.closed ?? second.status)}`);
  log(`PASS: the same socket answered 200 after ${idleMs} ms idle`);
}

function isCleanClose(reason) {
  return ['end', 'close', 'ECONNRESET', 'EPIPE', 'destroyed'].includes(reason);
}

async function drain(base, args) {
  const path = option(args, 'path', '/api/v1/health');
  const echo = option(args, 'echo', '/api/v1/echo');
  const t = target(base);
  await waitReady(base, path);

  // The idle kept-alive socket (A2's reuse case): one request, then idle.
  const { connection: idle } = await openKeptAlive(base, path);

  // The in-flight request: a POST with half its body.
  const payload = JSON.stringify({ smoke: 'drain', pad: 'x'.repeat(64) });
  const half = Math.floor(payload.length / 2);
  const inFlight = new Connection(t.host, t.port);
  await inFlight.open();
  await inFlight.write(
    request('POST', echo, t.hostHeader, { 'Content-Type': 'application/json' }, '').replace(
      'Content-Length: 0',
      `Content-Length: ${Buffer.byteLength(payload)}`,
    ) + payload.slice(0, half),
  );
  await sleep(500);
  if (inFlight.buffer.length > 0 || inFlight.closed !== null) fail('the half-sent request was answered or closed before SIGTERM');

  log(SIGNAL_MARKER);
  process.stdout.write(`${SIGNAL_MARKER}\n`);
  // The signal is observed by its effect: the idle socket is closed at
  // SIGTERM (or, at worst, 5 s pass and the reuse probe below judges it).
  const signalled = Date.now();
  const deadline = signalled + 5_000;
  while (idle.closed === null && Date.now() < deadline) await idle.changed(deadline - Date.now());
  log(`idle socket after the signal: ${idle.closed ?? 'still open'}`);
  const at = idle.closed === null ? signalled : Date.now();
  await sleep(1_000);

  // A new connection during the drain gets no 200.
  const fresh = await getOnce(base, path, 3_000);
  log(`new connection during the drain: ${JSON.stringify(fresh.closed ?? fresh.status)}`);
  if (fresh.status === 200) fail('a new connection during the drain was answered 200');

  // The reused idle socket: a clean close, or 200 with Connection: close.
  if (idle.closed !== null) {
    if (!isCleanClose(idle.closed)) fail(`the idle socket ended uncleanly: ${idle.closed}`);
    log('reused idle socket: closed cleanly before reuse');
  } else {
    const writeError = await idle.write(request('GET', path, t.hostHeader));
    const reused = writeError === null ? await idle.response(5_000) : { closed: writeError };
    if (reused.status === 200) {
      if ((reused.headers.connection ?? '').toLowerCase() !== 'close') fail('the reused socket answered 200 without Connection: close');
      log('reused idle socket: 200 with Connection: close');
    } else if (reused.closed !== undefined && isCleanClose(reused.closed) && reused.partial === 0) {
      log(`reused idle socket: clean close (${reused.closed})`);
    } else {
      fail(`the reused idle socket: ${JSON.stringify(reused)}`);
    }
  }
  idle.destroy();

  // The rest of the body, 3 s after the signal: the echo answers 200.
  await sleep(Math.max(0, at + 3_000 - Date.now()));
  const writeError = await inFlight.write(payload.slice(half));
  if (writeError !== null) fail(`the in-flight request's socket was closed before its body completed (${writeError})`);
  const answer = await inFlight.response(15_000);
  inFlight.destroy();
  if (answer.status !== 200) fail(`the in-flight request: ${JSON.stringify(answer.closed ?? answer.status)}`);
  let echoed;
  try {
    echoed = JSON.parse(answer.body).echoed;
  } catch {
    fail(`the echo body is not JSON: ${answer.body.slice(0, 200)}`);
  }
  if (JSON.stringify(echoed) !== payload) fail(`the echo does not match: ${answer.body.slice(0, 200)}`);
  if ((answer.headers.connection ?? '').toLowerCase() !== 'close') {
    fail(`the in-flight response did not carry Connection: close (got "${answer.headers.connection ?? ''}")`);
  }
  log('PASS: the in-flight request finished 200 with its echo and Connection: close; no new connection was served');
}

async function webDrain(base, args) {
  const path = option(args, 'path', '/runtime-config.js');
  const t = target(base);
  await waitReady(base, path);
  // A request held in flight: a server action POST whose body is half sent —
  // Next reads the whole body before it answers.
  const page = option(args, 'page', '/login');
  const body = 'x'.repeat(64);
  const inFlight = new Connection(t.host, t.port);
  await inFlight.open();
  await inFlight.write(
    `POST ${page} HTTP/1.1\r\nHost: ${t.hostHeader}\r\nConnection: keep-alive\r\nNext-Action: 0000000000000000000000000000000000000000\r\n` +
      `Content-Type: text/plain;charset=UTF-8\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 32)}`,
  );
  await sleep(500);
  if (inFlight.buffer.length > 0 || inFlight.closed !== null) fail('the half-sent request was answered or closed before SIGTERM');
  log(SIGNAL_MARKER);
  process.stdout.write(`${SIGNAL_MARKER}\n`);
  await sleep(2_000);
  const writeError = await inFlight.write(body.slice(32));
  if (writeError !== null) fail(`the in-flight request's socket was closed before its body completed (${writeError})`);
  const answer = await inFlight.response(15_000);
  inFlight.destroy();
  if (answer.status === undefined) fail(`the in-flight request got no response: ${JSON.stringify(answer)}`);
  if ((answer.headers.connection ?? '').toLowerCase() !== 'close') {
    fail(`the in-flight response did not carry Connection: close (status ${answer.status}, Connection "${answer.headers.connection ?? ''}")`);
  }
  log(`PASS: the in-flight request was answered (${answer.status}) with Connection: close`);
}

async function status(url, expected, args) {
  const parsed = new URL(url);
  const response = await getOnce(`${parsed.protocol}//${parsed.host}`, `${parsed.pathname}${parsed.search}`);
  const contains = option(args, 'contains', undefined);
  log(`GET ${url}: ${JSON.stringify(response.closed ?? response.status)} ${response.body?.slice(0, 400) ?? ''}`);
  if (String(response.status) !== expected) fail(`expected ${expected}`);
  if (contains !== undefined && !(response.body ?? '').includes(contains)) fail(`the body does not contain "${contains}"`);
}

const [mode, first, second, ...rest] = process.argv.slice(2);
const args = [second, ...rest].filter((arg) => arg !== undefined);
switch (mode) {
  case 'ready':
    await waitReady(first, option(args, 'path', '/api/v1/health'));
    break;
  case 'status':
    await status(first, second, rest);
    break;
  case 'keepalive':
    await keepalive(first, args);
    break;
  case 'drain':
    await drain(first, args);
    break;
  case 'web-drain':
    await webDrain(first, args);
    break;
  default:
    fail(`unknown mode "${mode ?? ''}" — ready | status | keepalive | drain | web-drain`);
}
process.exit(0);
