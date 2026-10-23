import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Story 6-2c (decision 9, A19) — every base image is a literal
 * `image:tag-alpine@sha256:<digest>` (no build ARG in a FROM), and the Bun
 * tag equals `.bun-version`, the pin CI runs.
 */
const ROOT = join(__dirname, '..');

export function fromLines(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^FROM\s/i.test(line))
    .map((line) => line.replace(/^FROM\s+/i, '').split(/\s+/)[0]!);
}

export function pinProblems(dockerfile: string, bunVersion: string): string[] {
  const problems: string[] = [];
  const images = fromLines(dockerfile);
  if (images.length === 0) problems.push('no FROM line');
  if (/^\s*ARG\s+(BUN|NODE)_VERSION/im.test(dockerfile)) problems.push('a BUN_VERSION/NODE_VERSION build ARG remains');
  for (const image of images) {
    const match = /^([a-z0-9./_-]+):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$/.exec(image);
    if (match === null) {
      problems.push(`${image}: not a literal image:tag@sha256:<64 hex> reference`);
      continue;
    }
    const [, name, tag] = match;
    if (!tag!.endsWith('-alpine')) problems.push(`${image}: not an -alpine variant`);
    if (name === 'oven/bun' && tag !== `${bunVersion}-alpine`) problems.push(`${image}: the Bun tag is not .bun-version (${bunVersion})`);
  }
  return problems;
}

describe('the Dockerfile pins (story 6-2c)', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const bunVersion = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();

  it('every FROM is a digest-pinned -alpine image; the Bun tag equals .bun-version', () => {
    expect(fromLines(dockerfile).length).toBeGreaterThanOrEqual(2);
    expect(pinProblems(dockerfile, bunVersion)).toEqual([]);
    for (const image of fromLines(dockerfile)) expect(image.startsWith(`oven/bun:${bunVersion}-alpine@sha256:`)).toBe(true);
  });

  it('the check bites: a lost digest, a lost -alpine, a tag drift, an ARG in FROM', () => {
    const good = 'FROM oven/bun:1.4.0-alpine@sha256:' + 'a'.repeat(64) + ' AS deps\n';
    expect(pinProblems(good, '1.4.0')).toEqual([]);
    expect(pinProblems('FROM oven/bun:1.4.0-alpine AS deps\n', '1.4.0')[0]).toMatch(/not a literal/);
    expect(pinProblems('FROM oven/bun:1.4.0@sha256:' + 'a'.repeat(64) + '\n', '1.4.0')[0]).toMatch(/-alpine/);
    expect(pinProblems(good, '1.4.2')[0]).toMatch(/\.bun-version/);
    expect(pinProblems('ARG BUN_VERSION=1.4.0\nFROM oven/bun:${BUN_VERSION}-alpine\n', '1.4.0')).toHaveLength(2);
  });

  it('the image carries the RDS CA bundle and points PGSSLROOTCERT at it (decision 11)', () => {
    expect(dockerfile).toMatch(/^COPY certs\/ \.\/certs\/$/m);
    expect(dockerfile).toMatch(/PGSSLROOTCERT=\/app\/certs\/rds-global-bundle\.pem/);
    expect(dockerfile).not.toMatch(/--chown/);
    expect(dockerfile).not.toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('the HEALTHCHECK follows the role: /health/worker for the worker, /health otherwise', () => {
    const healthcheck = /HEALTHCHECK[\s\S]*?CMD (bun -e "[^\n]+")/.exec(dockerfile)?.[1] ?? '';
    expect(healthcheck).toContain("process.env.WMS_PROCESS_ROLE==='worker'?'/api/v1/health/worker':'/api/v1/health'");
  });
});
