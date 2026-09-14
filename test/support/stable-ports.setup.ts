/**
 * infra-2: keep e2e servers OFF the OS ephemeral port range.
 *
 * ROOT CAUSE of the long-running intermittent e2e failure. supertest binds
 * each suite's server with `app.listen(0)` (lib/test.js:63), so the OS hands
 * it a port from the ephemeral range — on macOS 49152-65535. Other local
 * services live in that same range: on the machine where this was found,
 * Ollama's UI listened on 127.0.0.1:56745. A request built against a port the
 * test server no longer owned reached Ollama instead, and the suite saw a
 * perfectly valid `200 OK` carrying an HTML page.
 *
 * That is the whole mystery: a wrong-but-valid status on an unrelated route,
 * a different test each run, immune to database isolation, sensitive to
 * timing rather than logic. CI never saw it (nothing else is listening
 * there); it only ever hurt local runs.
 *
 * Fix: bind to a range the OS never auto-assigns, so only an explicitly
 * configured service could collide — and retry if one does.
 */
import net from 'node:net';

const RANGE_START = 21000;
const RANGE_END = 24999;
const MAX_ATTEMPTS = 200;

let cursor = RANGE_START + Math.floor(Math.random() * (RANGE_END - RANGE_START));

function nextPort(): number {
  cursor = cursor >= RANGE_END ? RANGE_START : cursor + 1;
  return cursor;
}

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function patchedListen(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  const wantsEphemeral =
    args.length === 0 ||
    args[0] === 0 ||
    args[0] === undefined ||
    (typeof args[0] === 'object' && args[0] !== null && (args[0] as { port?: number }).port === 0);
  if (!wantsEphemeral) {
    return originalListen.apply(this, args as never) as net.Server;
  }

  let attempts = 0;
  const rest = args.slice(1);
  const tryBind = (): net.Server => {
    attempts += 1;
    const port = nextPort();
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE' && attempts < MAX_ATTEMPTS) {
        this.removeListener('error', onError);
        tryBind();
        return;
      }
      this.removeListener('error', onError);
      this.emit('error', err);
    };
    this.once('error', onError);
    this.once('listening', () => this.removeListener('error', onError));
    return originalListen.apply(this, [port, ...rest] as never) as net.Server;
  };
  return tryBind();
};
