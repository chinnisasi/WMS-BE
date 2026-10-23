import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDatabaseTlsConfig, postgresTlsOptions, resetPostgresTlsWarnings, sslModeOf } from '../src/shared/db/pg-tls';
import { ConfigRefusal } from '../src/shared/lifecycle/process-role';

/**
 * Story 6-2c (decision 11, A4, A14) — the one TLS helper every pool goes
 * through. Each row of the helper's table, plus multi-host, PGSSLMODE and the
 * strict flag. The connections themselves (a wrong CA, a host outside the
 * SAN, verify-full end to end) are proven against a real TLS Postgres in the
 * CI `image` job.
 */
const dir = mkdtempSync(join(tmpdir(), 'pg-tls-'));
const BUNDLE = join(__dirname, '..', 'certs', 'rds-global-bundle.pem');
const NOT_PEM = join(dir, 'not-a-cert.pem');
writeFileSync(NOT_PEM, 'hello\n');

const URL_BASE = 'postgres://wms_app:pw@db.abc.ap-south-1.rds.amazonaws.com:5432/wms';

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigRefusal');
}

describe('postgresTlsOptions (story 6-2c)', () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);

  beforeEach(() => {
    warnings.length = 0;
    resetPostgresTlsWarnings();
  });

  it('verify-full + PGSSLROOTCERT: the PEM as `ca`, rejectUnauthorized true (overrides the URL sslmode)', () => {
    const options = postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { PGSSLROOTCERT: BUNDLE }, 'app', warn);
    expect(options.ssl?.rejectUnauthorized).toBe(true);
    expect(options.ssl?.ca).toContain('-----BEGIN CERTIFICATE-----');
    expect(warnings).toEqual([]);
  });

  it('verify-full without PGSSLROOTCERT, unreadable, or not a certificate: refused naming PGSSLROOTCERT', () => {
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, {}, 'app'))).toMatch(/needs PGSSLROOTCERT/);
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { PGSSLROOTCERT: '' }, 'app'))).toMatch(/PGSSLROOTCERT/);
    expect(
      refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { PGSSLROOTCERT: join(dir, 'missing.pem') }, 'app')),
    ).toMatch(/PGSSLROOTCERT .*unreadable/);
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { PGSSLROOTCERT: NOT_PEM }, 'app'))).toMatch(
      /holds no PEM certificate/,
    );
  });

  it('verify-ca: refused — use verify-full', () => {
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-ca`, { PGSSLROOTCERT: BUNDLE }))).toMatch(/use sslmode=verify-full/);
  });

  it.each(['sslrootcert=/x', 'sslcert=/c', 'sslkey=/k', 'sslcrl=/r', 'SSLROOTCERT=/x', 'SSLMODE=require'])(
    'any ssl* URL parameter but sslmode is refused (%s) — postgres.js would send it as a startup parameter (42704)',
    (parameter) => {
      expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full&${parameter}`, { PGSSLROOTCERT: BUNDLE }))).toMatch(
        /PGSSLROOTCERT/,
      );
      expect(refusal(() => postgresTlsOptions(`${URL_BASE}?${parameter}`, {}))).toMatch(/startup parameter/);
    },
  );

  it('sslnegotiation is allowed — postgres.js reads it itself and never forwards it', () => {
    expect(postgresTlsOptions(`${URL_BASE}?sslmode=verify-full&sslnegotiation=direct`, { PGSSLROOTCERT: BUNDLE }).ssl?.rejectUnauthorized).toBe(true);
    expect(postgresTlsOptions(`${URL_BASE}?sslnegotiation=postgres`, {})).toEqual({});
  });

  it('a repeated sslmode is refused (postgres.js keeps the last; the first must not be judged instead)', () => {
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full&sslmode=disable`, { PGSSLROOTCERT: BUNDLE }))).toMatch(/repeats sslmode/);
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=require&sslmode=require`, {}))).toMatch(/repeats sslmode/);
  });

  it.each(['PGSSLMODE', 'PGSSL'])('%s set is refused (postgres.js would not honour it as libpq does)', (variable) => {
    expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { [variable]: 'verify-full', PGSSLROOTCERT: BUNDLE }))).toContain(
      variable,
    );
    expect(refusal(() => postgresTlsOptions(URL_BASE, { [variable]: '' }))).toContain(variable);
  });

  it('a multi-host URL parses the way postgres.js reads it (split at the first ?)', () => {
    const multi = 'postgres://u:p@h1:5432,h2:5433/wms?sslmode=verify-full&application_name=x';
    expect(sslModeOf(multi)).toBe('verify-full');
    expect(postgresTlsOptions(multi, { PGSSLROOTCERT: BUNDLE }).ssl?.rejectUnauthorized).toBe(true);
    expect(refusal(() => postgresTlsOptions('postgres://u:p@h1,h2/wms?sslrootcert=/x', {}))).toMatch(/sslrootcert/);
  });

  it('other sslmodes are unchanged (no ssl option); a non-ssl parameter is no concern of the helper', () => {
    for (const mode of ['require', 'prefer', 'disable', 'allow']) {
      expect(postgresTlsOptions(`${URL_BASE}?sslmode=${mode}`, {}, 'app', warn)).toEqual({});
    }
    expect(postgresTlsOptions(`${URL_BASE}?application_name=wms`, {}, 'app', warn)).toEqual({});
    expect(postgresTlsOptions(URL_BASE, {}, 'app', warn)).toEqual({});
    expect(warnings).toEqual([]); // outside production nothing is said
  });

  it('production, not verify-full: connects, with ONE warning per pool naming it', () => {
    const env = { NODE_ENV: 'production' };
    expect(postgresTlsOptions(`${URL_BASE}?sslmode=require`, env, 'app', warn)).toEqual({});
    expect(postgresTlsOptions(`${URL_BASE}?sslmode=require`, env, 'app', warn)).toEqual({});
    expect(postgresTlsOptions(URL_BASE, env, 'auth', warn)).toEqual({});
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/pool "app": sslmode=require/);
    expect(warnings[1]).toMatch(/pool "auth": no sslmode/);
  });

  it('the strict flag (DATABASE_TLS_REQUIRE_VERIFY_FULL=1) turns the warning into a refusal — in any environment', () => {
    for (const env of [{ DATABASE_TLS_REQUIRE_VERIFY_FULL: '1' }, { DATABASE_TLS_REQUIRE_VERIFY_FULL: '1', NODE_ENV: 'production' }]) {
      expect(refusal(() => postgresTlsOptions(`${URL_BASE}?sslmode=require`, env, 'app'))).toMatch(
        /DATABASE_TLS_REQUIRE_VERIFY_FULL=1.*sslmode=require/,
      );
      expect(refusal(() => postgresTlsOptions(URL_BASE, env, 'auth'))).toMatch(/pool "auth".*no sslmode/);
      expect(postgresTlsOptions(`${URL_BASE}?sslmode=verify-full`, { ...env, PGSSLROOTCERT: BUNDLE }).ssl).toBeDefined();
    }
  });

  it('assertDatabaseTlsConfig (A4) judges DATABASE_URL and, when set, DATABASE_AUTH_URL — without connecting', () => {
    expect(() => assertDatabaseTlsConfig({})).not.toThrow(); // the pools are lazy: an unset URL is the first query's business
    expect(() => assertDatabaseTlsConfig({ DATABASE_URL: `${URL_BASE}?sslmode=verify-full`, PGSSLROOTCERT: BUNDLE })).not.toThrow();
    expect(refusal(() => assertDatabaseTlsConfig({ DATABASE_URL: `${URL_BASE}?sslrootcert=/x` }))).toMatch(/pool "app"/);
    expect(
      refusal(() =>
        assertDatabaseTlsConfig({
          DATABASE_URL: `${URL_BASE}?sslmode=verify-full`,
          DATABASE_AUTH_URL: `${URL_BASE}?sslmode=verify-ca`,
          PGSSLROOTCERT: BUNDLE,
        }),
      ),
    ).toMatch(/pool "auth"/);
  });
});
