import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Story 6-2c (A14) — every Postgres pool goes through `postgresTlsOptions`.
 * `postgres(` may appear under `src/` only in the three files that create a
 * pool, and each of those must apply the helper.
 */
const SRC = join(__dirname, '..', 'src');
const ALLOWED = ['shared/db/db.ts', 'shared/db/migrate-deploy.ts', 'shared/db/provision-roles.ts'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith('.ts') ? [path] : [];
  });
}

/** A call of the postgres.js factory: `postgres(` not preceded by an identifier character or a dot. */
const POOL_CALL = /(?<![\w.$])postgres\(/;

describe('every Postgres pool goes through the TLS helper (story 6-2c)', () => {
  const sites = files(SRC)
    .filter((path) => POOL_CALL.test(readFileSync(path, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
    .map((path) => relative(SRC, path));

  it('the detector bites', () => {
    expect(POOL_CALL.test('const sql = postgres(url, {})')).toBe(true);
    expect(POOL_CALL.test('await createPostgres(url)')).toBe(false);
    expect(POOL_CALL.test('lib.postgres(url)')).toBe(false);
  });

  it('postgres( appears only in db.ts, migrate-deploy.ts and provision-roles.ts', () => {
    expect(sites.sort()).toEqual([...ALLOWED].sort());
  });

  it.each(ALLOWED)('%s applies postgresTlsOptions in its pool options', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    expect(source).toMatch(/postgres\([^;]*\.\.\.postgresTlsOptions\(/s);
  });
});
