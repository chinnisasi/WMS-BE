import { readFileSync } from 'node:fs';
import { ConfigRefusal } from '../lifecycle/process-role';

/**
 * Story 6-2c (decision 11, A4, A14) — TLS to Postgres with certificate and
 * host verification.
 *
 * postgres.js 3.4.9 maps `?sslmode=require` to `rejectUnauthorized: false`
 * (`connection.js:283-286`): encrypted, but any certificate is accepted. And
 * `?sslmode=verify-full` alone reaches `tls.connect` with Node's default
 * trust store, which does not hold the RDS CA (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
 * So every pool is created with these options:
 *
 *   sslmode=verify-full  the PEM at `PGSSLROOTCERT` is read and passed as
 *                        `ssl: {ca, rejectUnauthorized: true}` — the `ssl`
 *                        option overrides the URL's sslmode; postgres.js sets
 *                        `servername` to the host, so Node checks the SAN
 *   sslmode=verify-ca    refused: use verify-full
 *   sslmode repeated     refused (postgres.js keeps the last value)
 *   sslnegotiation       allowed (postgres.js reads it itself)
 *   any other ssl* URL   refused: postgres.js forwards an unknown query
 *   parameter            parameter as a STARTUP parameter (`index.js:487-488`)
 *                        and the server fails the connection (`sslrootcert`
 *                        → 42704); use `PGSSLROOTCERT`
 *   PGSSLMODE / PGSSL    refused: postgres.js ignores the first silently and
 *                        reads the second as a default `ssl` — either would
 *                        mislead an operator
 *   anything else        unchanged; in production a one-time warning per pool
 *                        names it, and `DATABASE_TLS_REQUIRE_VERIFY_FULL=1`
 *                        (6-2d sets it) turns the warning into a refusal
 *
 * Every refusal is a `ConfigRefusal` (exit 78). Never `NODE_EXTRA_CA_CERTS`:
 * it would widen the trust of every outbound TLS call, not just Postgres'.
 *
 * The host must be the RDS-assigned endpoint, so the certificate's SAN
 * matches; RDS Proxy would need another trust source (PENDING).
 */

export type PostgresTlsOptions = { ssl?: { ca: string; rejectUnauthorized: true } };

const warnedPools = new Set<string>();

/** The URL's query, read the way postgres.js reads it: split at the first `?` (so a multi-host URL parses). */
export function urlQuery(url: string): URLSearchParams {
  const at = url.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
}

/** The URL's `sslmode`, or null when absent. */
export function sslModeOf(url: string): string | null {
  return urlQuery(url).get('sslmode');
}

/**
 * The postgres.js options a pool on `url` must be created with. Throws
 * `ConfigRefusal` on a refused configuration; never connects.
 */
export function postgresTlsOptions(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  pool = 'database',
  warn: (line: string) => void = (line) => console.warn(line),
): PostgresTlsOptions {
  for (const variable of ['PGSSLMODE', 'PGSSL'] as const) {
    if (env[variable] !== undefined) {
      throw new ConfigRefusal(
        `${variable} is set (pool "${pool}") — postgres.js does not honour it as libpq does; ` +
          'put sslmode in the database URL (?sslmode=verify-full) and unset it',
      );
    }
  }
  const query = urlQuery(url);
  // `sslnegotiation` is an option postgres.js itself reads (never forwarded), so it stays allowed.
  const refusedParameters = [...new Set(query.keys())].filter(
    (key) => key.toLowerCase().startsWith('ssl') && key !== 'sslmode' && key !== 'sslnegotiation',
  );
  if (refusedParameters.length > 0) {
    throw new ConfigRefusal(
      `the database URL (pool "${pool}") carries ${refusedParameters.join(', ')} — postgres.js would send ` +
        'it to the server as a startup parameter, which fails the connection. Only sslmode is read from the URL; ' +
        'set the CA bundle with PGSSLROOTCERT',
    );
  }
  // postgres.js keeps the LAST of a repeated parameter; this helper would judge
  // the first — so a repeat is refused rather than judged ambiguously.
  if (query.getAll('sslmode').length > 1) {
    throw new ConfigRefusal(`the database URL (pool "${pool}") repeats sslmode — give it once`);
  }
  const sslmode = query.get('sslmode');
  if (sslmode === 'verify-ca') {
    throw new ConfigRefusal(
      `sslmode=verify-ca (pool "${pool}") is not supported — use sslmode=verify-full (the RDS endpoint is in the certificate)`,
    );
  }
  if (sslmode === 'verify-full') {
    return { ssl: { ca: readRootCertificates(env, pool), rejectUnauthorized: true } };
  }
  if (env.DATABASE_TLS_REQUIRE_VERIFY_FULL === '1') {
    throw new ConfigRefusal(
      `DATABASE_TLS_REQUIRE_VERIFY_FULL=1, but the database URL (pool "${pool}") has ` +
        `${sslmode === null ? 'no sslmode' : `sslmode=${sslmode}`} — set ?sslmode=verify-full`,
    );
  }
  if (env.NODE_ENV === 'production' && !warnedPools.has(pool)) {
    warnedPools.add(pool);
    warn(
      `Database pool "${pool}": ${sslmode === null ? 'no sslmode' : `sslmode=${sslmode}`} — the server's certificate ` +
        'is NOT verified. Set ?sslmode=verify-full (the image carries the RDS CA bundle at PGSSLROOTCERT).',
    );
  }
  return {};
}

function readRootCertificates(env: NodeJS.ProcessEnv, pool: string): string {
  const path = env.PGSSLROOTCERT;
  if (path === undefined || path === '') {
    throw new ConfigRefusal(
      `sslmode=verify-full (pool "${pool}") needs PGSSLROOTCERT — the path of the CA bundle that signs the server's certificate`,
    );
  }
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigRefusal(
      `PGSSLROOTCERT (pool "${pool}") is unreadable: ${path} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(pem)) {
    throw new ConfigRefusal(`PGSSLROOTCERT (pool "${pool}") holds no PEM certificate: ${path}`);
  }
  return pem;
}

/**
 * A4 — the boot validation, for both roles, without connecting: the app
 * pool's `DATABASE_URL` and, when set, the auth pool's `DATABASE_AUTH_URL`.
 * An unset `DATABASE_URL` is not judged here (the pools are lazy; the first
 * query reports it).
 */
export function assertDatabaseTlsConfig(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL;
  if (url !== undefined && url !== '') postgresTlsOptions(url, env, 'app');
  const authUrl = env.DATABASE_AUTH_URL;
  if (authUrl !== undefined && authUrl !== '') postgresTlsOptions(authUrl, env, 'auth');
}

/** Test seam: forget which pools were warned about. */
export function resetPostgresTlsWarnings(): void {
  warnedPools.clear();
}
