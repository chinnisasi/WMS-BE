import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { assertApiRunsNoJobs, ConfigRefusal, enabledJobPollVariables, JOB_POLL_VARIABLES, parseProcessRole } from '../src/shared/lifecycle/process-role';

/**
 * Story 6-2c (A18) — every boot refusal exits 78 (EX_CONFIG), a crash 1.
 * Spawned against the real entry point (`bun src/main.ts`, the image's CMD),
 * in a scrubbed environment: only what each case sets reaches the process
 * (no inherited variables, no `.env` file).
 */
jest.setTimeout(120_000);

const ROOT = join(__dirname, '..');
const MFA = 'boot-refusal-test-mfa-encryption-key-0123456789';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wms:wms@localhost:55432/wms';

function boot(env: Record<string, string>): { status: number | null; stderr: string; stdout: string } {
  // --no-env-file: a developer's .env must not leak into the case (Bun loads it by default).
  const result = spawnSync('bun', ['--no-env-file', 'src/main.ts'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = 25_000 + Math.floor(Math.random() * 4_000);
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

describe('boot refusals exit 78 (story 6-2c, A18)', () => {
  describe('the rules', () => {
    it('the role: unset or empty is api; api and worker; anything else refuses', () => {
      expect(parseProcessRole(undefined)).toBe('api');
      expect(parseProcessRole('')).toBe('api');
      expect(parseProcessRole('worker')).toBe('worker');
      expect(() => parseProcessRole('foo')).toThrow(ConfigRefusal);
      expect(() => parseProcessRole('Worker')).toThrow(ConfigRefusal);
    });

    it('a production API with a job switched on refuses; 0, unset, dev, WMS_API_RUNS_JOBS=1 and the worker role do not', () => {
      expect(JOB_POLL_VARIABLES).toHaveLength(13);
      const prod = { NODE_ENV: 'production' };
      expect(() => assertApiRunsNoJobs('api', { ...prod, OUTBOX_RELAY_POLL_MS: '2000' })).toThrow(/OUTBOX_RELAY_POLL_MS/);
      expect(() => assertApiRunsNoJobs('api', { ...prod, SESSION_PURGE_POLL_MS: 'x' })).toThrow(ConfigRefusal); // non-zero, if malformed
      expect(() => assertApiRunsNoJobs('api', { ...prod, OUTBOX_RELAY_POLL_MS: '0', PUSH_SENDER_POLL_MS: '' })).not.toThrow();
      expect(() => assertApiRunsNoJobs('api', { OUTBOX_RELAY_POLL_MS: '2000' })).not.toThrow(); // dev / tests
      expect(() => assertApiRunsNoJobs('api', { ...prod, OUTBOX_RELAY_POLL_MS: '2000', WMS_API_RUNS_JOBS: '1' })).not.toThrow();
      expect(() => assertApiRunsNoJobs('worker', { ...prod, OUTBOX_RELAY_POLL_MS: '2000' })).not.toThrow();
      expect(enabledJobPollVariables({ COUNT_SCHEDULER_POLL_MS: '3600000', LICENCE_EXPIRY_POLL_MS: '0' })).toEqual(['COUNT_SCHEDULER_POLL_MS']);
    });
  });

  describe('spawned: bun src/main.ts', () => {
    const base = { MFA_ENCRYPTION_KEY: MFA, DATABASE_URL };

    it.each<[string, Record<string, string>, RegExp]>([
      ['a bad role', { ...base, WMS_PROCESS_ROLE: 'foo' }, /WMS_PROCESS_ROLE must be one of api, worker/],
      ['a heartbeat setting below 60000', { ...base, WORKER_HEARTBEAT_STALE_MS: '59999' }, /WORKER_HEARTBEAT_STALE_MS/],
      ['a heartbeat setting of 0', { ...base, WORKER_HEARTBEAT_STALE_MS: '0' }, /WORKER_HEARTBEAT_STALE_MS/],
      ['sslrootcert in the URL', { ...base, DATABASE_URL: `${DATABASE_URL}?sslrootcert=/x` }, /sslrootcert/],
      ['PGSSLMODE set', { ...base, PGSSLMODE: 'verify-full' }, /PGSSLMODE/],
      ['verify-full without a CA', { ...base, DATABASE_URL: `${DATABASE_URL}?sslmode=verify-full` }, /PGSSLROOTCERT/],
      ['verify-ca on the auth pool', { ...base, DATABASE_AUTH_URL: `${DATABASE_URL}?sslmode=verify-ca` }, /pool "auth"/],
      ['the strict flag with sslmode=require', { ...base, DATABASE_URL: `${DATABASE_URL}?sslmode=require`, DATABASE_TLS_REQUIRE_VERIFY_FULL: '1' }, /DATABASE_TLS_REQUIRE_VERIFY_FULL/],
      ['a production API with a job switched on', { ...base, NODE_ENV: 'production', OUTBOX_RELAY_POLL_MS: '2000' }, /run the jobs on the worker task/],
      ['the MFA key missing (was exit 1)', { DATABASE_URL }, /MFA_ENCRYPTION_KEY/],
      ['a bad PORT (api role)', { ...base, PORT: 'eighty' }, /Invalid PORT "eighty"/],
      ['a bad PORT (worker role)', { ...base, WMS_PROCESS_ROLE: 'worker', OUTBOX_RELAY_POLL_MS: '3600000', PORT: '70000' }, /Invalid PORT "70000"/],
      ['a bad *_POLL_MS (worker role)', { ...base, WMS_PROCESS_ROLE: 'worker', OUTBOX_RELAY_POLL_MS: 'soon' }, /OUTBOX_RELAY_POLL_MS must be a non-negative integer/],
      ['a bad *_POLL_MS (worker role, the shared parser)', { ...base, WMS_PROCESS_ROLE: 'worker', PUSH_SENDER_POLL_MS: '1.5' }, /PUSH_SENDER_POLL_MS must be a non-negative integer/],
    ])('%s → exit 78, with the reason', (_name, env, reason) => {
      const result = boot(env);
      expect(result.stderr).toMatch(reason);
      expect(result.stderr).toMatch(/Refusing to start/);
      expect(result.status).toBe(78);
    });

    it('a worker with no job enabled → exit 78, after init', async () => {
      const port = await freePort();
      const result = boot({ ...base, WMS_PROCESS_ROLE: 'worker', PORT: String(port) });
      expect(result.stderr).toMatch(/no job is enabled/);
      expect(result.status).toBe(78);
    });

    it('a SIGTERM during boot (app.init() waiting on an unreachable database) exits 0, not 143', async () => {
      const port = await freePort();
      const child = spawn('bun', ['--no-env-file', 'src/main.ts'], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          MFA_ENCRYPTION_KEY: MFA,
          // A non-routable address: the startup counter rebuild's connect hangs, holding init.
          DATABASE_URL: 'postgres://wms:wms@10.255.255.1:5432/wms',
          PORT: String(port),
        },
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      try {
        const deadline = Date.now() + 30_000;
        while (!output.includes('Starting Nest application') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(output).toContain('Starting Nest application');
        await new Promise((r) => setTimeout(r, 1_500)); // well into init, still connecting
        expect(output).not.toContain('wms-be listening');
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        expect(output).toContain('SIGTERM during boot');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    });

    it('a worker whose health port is taken (EADDRINUSE) → exit 1, a crash, not a refusal', async () => {
      const port = await freePort();
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(port, '0.0.0.0', () => resolve()));
      try {
        const child = spawn('bun', ['--no-env-file', 'src/main.ts'], {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            ...base,
            WMS_PROCESS_ROLE: 'worker',
            PORT: String(port),
            OUTBOX_RELAY_POLL_MS: '3600000',
          },
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        const status = await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
        expect(stderr).toMatch(/EADDRINUSE/);
        expect(status).toBe(1);
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });
  });
});
