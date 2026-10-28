/**
 * Story 5-2a (A11; shared with 5-2b, decision 2) — is this error worth a
 * retry of the whole outbox row? Only a CONNECTION or SERIALIZATION fault is:
 * SQLSTATE class `08` (connection exception), `40001` (serialization
 * failure), `40P01` (deadlock), `57P01`–`57P03` (the server shutting down or
 * not yet accepting connections), or a client-side connect / pool error
 * (postgres.js `CONNECTION_*`, a socket `ECONNREFUSED` / `ECONNRESET` /
 * `ETIMEDOUT` / `EPIPE`). Everything else — a data fault, a CHECK, a bug —
 * is deterministic and a retry cannot fix it; the subscriber logs and acks.
 *
 * Walks the `cause` chain (drizzle wraps driver errors in `DrizzleQueryError`).
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '57P01', '57P02', '57P03']);
const TRANSIENT_CLIENT_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

export function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (/^08[0-9A-Z]{3}$/.test(code) || TRANSIENT_SQLSTATES.has(code) || TRANSIENT_CLIENT_CODES.has(code)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
