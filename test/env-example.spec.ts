import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Story 6-2a (A9) — every environment variable the backend reads is
 * documented in `.env.example`, which is what docs/design/DEPLOY.md's env
 * list is built from. A variable read only in code is one a deploy never
 * sets (as `COUNT_SCHEDULER_POLL_MS`, `CHANNELS_SYNC_POLL_MS` and five
 * others were before this story).
 *
 * "Read" covers `process.env.NAME`, `env.NAME` on a `NodeJS.ProcessEnv`
 * parameter (the `…FromEnv` factories), `process.env[CONSTANT]` with the
 * constant's string resolved in the same file, and `envInt('NAME', …)` (the
 * deploy migrator). Documented means a `NAME=` line, commented out or not.
 */
const ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

export function variablesReadIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\benvInt\(\s*'([A-Z][A-Z0-9_]*)'/g)) names.add(m[1]!);
  const constants = new Map<string, string>();
  for (const m of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) constants.set(m[1]!, m[2]!);
  for (const m of source.matchAll(/process\.env\[\s*([A-Z][A-Z0-9_]*)\s*\]/g)) {
    const resolved = constants.get(m[1]!);
    if (resolved === undefined) throw new Error(`process.env[${m[1]}] — the constant is not a string literal in this file`);
    names.add(resolved);
  }
  for (const m of source.matchAll(/process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g)) names.add(m[1]!);
  return names;
}

describe('.env.example documents every variable the code reads (story 6-2a, A9)', () => {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

  const read = new Map<string, string[]>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    for (const name of variablesReadIn(readFileSync(file, 'utf8'))) {
      read.set(name, [...(read.get(name) ?? []), file.slice(ROOT.length + 1)]);
    }
  }

  it('finds the variables (the scan is not vacuous)', () => {
    for (const name of ['DATABASE_URL', 'VALKEY_URL', 'PUSH_GATEWAY', 'CHANNEL_HTTP_TIMEOUT_MS', 'MIGRATE_LARGE_TABLE_ROWS']) {
      expect(read.has(name)).toBe(true);
    }
    expect(read.size).toBeGreaterThan(40);
  });

  it('every variable read under src/ has a NAME= line in .env.example', () => {
    const missing = [...read.entries()]
      .filter(([name]) => !documented.has(name))
      .map(([name, files]) => `${name} (read in ${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('the scan bites: a variable read only in code is reported', () => {
    expect([...variablesReadIn("const T = 'SOME_VAR'; process.env[T]; process.env.OTHER_VAR; env.THIRD;")].sort()).toEqual([
      'OTHER_VAR',
      'SOME_VAR',
      'THIRD',
    ]);
  });
});
