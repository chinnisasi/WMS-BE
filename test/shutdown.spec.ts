import { spawn } from 'node:child_process';
import net, { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Agent, request as httpRequest } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { HealthController, type HealthResponse } from '../src/api/health.controller';
import { JobsModule, OutboxRelayWorker } from '../src/jobs/jobs.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { DatabaseLifecycle } from '../src/shared/lifecycle/database-lifecycle';
import { HttpDrain } from '../src/shared/lifecycle/http-drain';
import {
  InFlightTick,
  armForceExit,
  resetShutdownDrainDeadline,
  settleBefore,
  shutdownDrainDeadline,
  SHUTDOWN_DRAIN_MS,
} from '../src/shared/lifecycle/shutdown';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { registeredJobs, resetWorkerHeartbeats, WORKER_JOBS } from '../src/shared/lifecycle/worker-heartbeat';
import { JOB_POLL_VARIABLES } from '../src/shared/lifecycle/process-role';
import { readFileSync } from 'node:fs';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Cloning the suite database and booting the whole app outlive the 5 s default.
jest.setTimeout(30_000);

/**
 * Story 6-2a — graceful shutdown (decision 5, A1). The order is Nest's real
 * one (`close`: prepareClose → onModuleDestroy → beforeApplicationShutdown →
 * dispose → onApplicationShutdown), and the test drives the REAL app through
 * it: a worker mid-tick, a request mid-flight, then `app.close()` — the same
 * sequence a SIGTERM runs through `enableShutdownHooks`.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('graceful shutdown (story 6-2a)', () => {
  afterEach(() => {
    resetShutdownDrainDeadline();
  });

  describe('the primitives', () => {
    it('InFlightTick: one tick at a time; settle waits for it, then refuses new ticks', async () => {
      const ticks = new InFlightTick();
      const first = deferred();
      let started = 0;
      ticks.start(() => {
        started += 1;
        return first.promise;
      });
      ticks.start(() => {
        started += 1;
        return Promise.resolve();
      }); // shed: one is in flight
      expect(started).toBe(1);
      let settled = false;
      const settling = ticks.settle(Date.now() + 5_000).then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      first.resolve();
      expect(await settling).toBe(true);
      ticks.start(() => {
        started += 1;
        return Promise.resolve();
      });
      expect(started).toBe(1); // stopped
    });

    it('InFlightTick: a tick that never ends is abandoned at the deadline (bounded), a failing tick settles', async () => {
      const hung = new InFlightTick();
      hung.start(() => new Promise(() => undefined));
      const t0 = Date.now();
      expect(await hung.settle(Date.now() + 50)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1_000);

      const failing = new InFlightTick();
      failing.start(() => Promise.reject(new Error('tick failed')));
      expect(await failing.settle(Date.now() + 1_000)).toBe(true);
    });

    it('the drain deadline is shared: the second waiter gets the first one\'s deadline', () => {
      const first = shutdownDrainDeadline(1_000);
      expect(shutdownDrainDeadline(9_000)).toBe(first);
      expect(first).toBe(21_000);
    });

    it('settleBefore: a deadline already past answers false at once (C25 — awaited)', async () => {
      await expect(settleBefore(Promise.resolve(), 0)).resolves.toBe(false);
      await expect(settleBefore(Promise.resolve(), Date.now() + 1_000)).resolves.toBe(true);
    });

    it('armForceExit: the first signal arms a timer that exits 75 (story 6-2c, A18 — was 1) when the sequence overruns', async () => {
      const exits: number[] = [];
      const disarm = armForceExit(30, (code) => exits.push(code), ['SIGUSR2']);
      try {
        process.emit('SIGUSR2', 'SIGUSR2');
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(exits).toEqual([75]);
      } finally {
        disarm();
      }
    });

    it('armForceExit (C4): the listener stays; a second signal is a no-op — one timer, one exit', async () => {
      const exits: number[] = [];
      const before = process.listenerCount('SIGUSR2');
      const disarm = armForceExit(60, (code) => exits.push(code), ['SIGUSR2']);
      try {
        process.emit('SIGUSR2', 'SIGUSR2');
        // Still listening after the first signal — a second one never reaches Node's default action.
        expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        process.emit('SIGUSR2', 'SIGUSR2');
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(exits).toEqual([75]);
      } finally {
        disarm();
      }
      expect(process.listenerCount('SIGUSR2')).toBe(before);
    });

    it('armForceExit (C5/C35): the first signal fixes the drain deadline at signal time + the drain budget', async () => {
      const disarm = armForceExit(60_000, () => undefined, ['SIGUSR2']);
      try {
        const signalledAt = Date.now();
        process.emit('SIGUSR2', 'SIGUSR2');
        await new Promise((resolve) => setTimeout(resolve, 50));
        // A waiter arriving later gets the SIGNAL's deadline, not its own start + the budget.
        const deadline = shutdownDrainDeadline(Date.now());
        expect(deadline).toBeGreaterThanOrEqual(signalledAt + SHUTDOWN_DRAIN_MS);
        expect(deadline).toBeLessThan(signalledAt + SHUTDOWN_DRAIN_MS + 40);
      } finally {
        disarm();
      }
    });
  });

  describe('the real app, closed the way SIGTERM closes it', () => {
    let suiteDb: SuiteDatabase;

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('shutdown');
    });

    afterAll(async () => {
      await suiteDb?.drop();
    });

    /**
     * Boots the real app with the teardown phases recorded. Spies are set
     * per test (jest's restoreMocks undoes them before every test).
     */
    async function boot(withWorker: boolean) {
      if (withWorker) process.env.OUTBOX_RELAY_POLL_MS = '20';
      const app: INestApplication = await createApp(false);
      delete process.env.OUTBOX_RELAY_POLL_MS;
      const events: string[] = [];
      const drain = deferred<string[]>();
      const handler = deferred<HealthResponse>();
      const state = { drainCalls: 0 };
      // The relay worker's tick blocks until the test lets it finish.
      jest.spyOn(app.get<OutboxRelay>(OUTBOX_RELAY), 'drain').mockImplementation(async () => {
        state.drainCalls += 1;
        const published = await drain.promise;
        events.push('worker tick finished');
        return published as never;
      });
      // A slow request: the liveness handler waits for the test.
      jest.spyOn(app.get(HealthController), 'health').mockImplementation(
        () =>
          handler.promise.then((value) => {
            events.push('request handled');
            return value;
          }) as unknown as HealthResponse,
      );
      const adapter = app.getHttpAdapter() as unknown as { close: () => Promise<void> };
      const close = adapter.close.bind(adapter);
      jest.spyOn(adapter, 'close').mockImplementation(async () => {
        events.push('http server closed (dispose)');
        await close();
      });
      const lifecycle = app.get(DatabaseLifecycle);
      const poolsClose = lifecycle.onApplicationShutdown.bind(lifecycle);
      jest.spyOn(lifecycle, 'onApplicationShutdown').mockImplementation(async () => {
        events.push('postgres pools closed');
        await poolsClose();
      });
      const valkey = app.get(ValkeyClient);
      const valkeyClose = valkey.onApplicationShutdown.bind(valkey);
      jest.spyOn(valkey, 'onApplicationShutdown').mockImplementation(async () => {
        events.push('valkey closed');
        await valkeyClose();
      });
      await app.listen(0, '127.0.0.1');
      const port = (app.getHttpServer().address() as AddressInfo).port;
      let closed = false;
      const closeApp = () =>
        app.close().then(() => {
          closed = true;
          events.push('close resolved');
        });
      const ok = (): HealthResponse => ({ status: 'ok', service: 'wms-be', time: new Date().toISOString() });
      return { app, port, events, drain, handler, state, closeApp, isClosed: () => closed, ok };
    }

    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function expectPoolsLast(events: string[]): void {
      const disposeAt = events.indexOf('http server closed (dispose)');
      expect(disposeAt).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('postgres pools closed')).toBeGreaterThan(disposeAt);
      expect(events.indexOf('valkey closed')).toBeGreaterThan(disposeAt);
      expect(events[events.length - 1]).toBe('close resolved');
    }

    it('a worker mid-tick: the timer stops, the tick is awaited, and only then does the server close and the pools after it', async () => {
      const t = await boot(true);
      await until(() => t.state.drainCalls === 1);
      const closing = t.closeApp();
      await pause(150);
      expect(t.isClosed()).toBe(false);
      expect(t.events).toEqual([]); // nothing torn down under the running tick
      expect(t.state.drainCalls).toBe(1); // and no new tick started
      t.drain.resolve([]);
      await closing;
      expect(t.events[0]).toBe('worker tick finished');
      expectPoolsLast(t.events);
      expect(t.state.drainCalls).toBe(1);
    });

    it('a request mid-flight: new connections are refused, the request finishes 200, then the server closes and the pools after it', async () => {
      const t = await boot(false);
      const inFlight = get(t.port, '/api/v1/health');
      const drainHttp = t.app.get(HttpDrain);
      await until(() => drainHttp.inFlightRequests === 1);
      const closing = t.closeApp();
      await pause(150);
      expect(t.isClosed()).toBe(false);
      expect(t.events).toEqual([]); // nothing torn down under the request
      // The listener no longer accepts connections.
      await expect(get(t.port, '/api/v1/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      t.handler.resolve(t.ok());
      expect((await inFlight).status).toBe(200);
      await closing;
      expect(t.events[0]).toBe('request handled');
      expectPoolsLast(t.events);
    });

    it('return503OnClosing (C22): once shutdown has begun, a request that reaches the app is answered 503, Connection: close', async () => {
      const t = await boot(false);
      t.handler.resolve(t.ok());
      expect((await get(t.port, '/api/v1/health')).status).toBe(200);
      // `prepareClose` — the first step of close() — calls exactly this.
      (t.app.getHttpAdapter() as unknown as { beforeClose: () => void }).beforeClose();
      const refused = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: t.port, path: '/api/v1/health', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(refused).toEqual({ status: 503, connection: 'close' });
      await t.closeApp();
    });

    it('forceCloseConnections (C22): a keep-alive request still hung at the drain deadline is cut, and close() still ends', async () => {
      const t = await boot(false);
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const hung = new Promise<string>((resolve) => {
          const req = httpRequest({ host: '127.0.0.1', port: t.port, path: '/api/v1/health', agent }, () => resolve('answered'));
          req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
          req.end();
        });
        const drainHttp = t.app.get(HttpDrain);
        await until(() => drainHttp.inFlightRequests === 1);
        // A short drain budget: the deadline passes with the request still blocked.
        shutdownDrainDeadline(Date.now() - SHUTDOWN_DRAIN_MS + 200);
        const t0 = Date.now();
        await t.closeApp(); // without forceCloseConnections, server.close() would wait on the hung socket forever
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(await hung).toMatch(/ECONNRESET|socket hang up|error/);
        expectPoolsLast(t.events);
      } finally {
        agent.destroy();
        t.handler.resolve(t.ok());
      }
    });

    it('A2 (story 6-2c): a keep-alive request in flight when the drain begins is answered with Connection: close, and the socket is not kept', async () => {
      const t = await boot(false);
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      try {
        // A first request on the kept-alive socket, answered keep-alive (the drain has not begun).
        t.handler.resolve(t.ok());
        const before = await new Promise<{ connection: string | undefined }>((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port: t.port, path: '/api/v1/health', agent }, (res) => {
            res.resume();
            res.on('end', () => resolve({ connection: res.headers.connection }));
          });
          req.on('error', reject);
          req.end();
        });
        expect(before.connection).toBe('keep-alive');
        // The second request blocks in the handler while the drain begins.
        const blocked = deferred<HealthResponse>();
        jest.spyOn(t.app.get(HealthController), 'health').mockImplementation(() => blocked.promise as unknown as HealthResponse);
        let socketClosed = false;
        const inFlight = new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port: t.port, path: '/api/v1/health', agent }, (res) => {
            res.socket.once('close', () => (socketClosed = true));
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }));
          });
          req.on('error', reject);
          req.end();
        });
        const drainHttp = t.app.get(HttpDrain);
        await until(() => drainHttp.inFlightRequests === 1);
        const closing = t.closeApp();
        await until(() => drainHttp.isDraining);
        blocked.resolve(t.ok());
        expect(await inFlight).toEqual({ status: 200, connection: 'close' });
        await until(() => socketClosed); // the server ends the socket with the response
        await closing;
        expectPoolsLast(t.events);
      } finally {
        agent.destroy();
      }
    });

    it('every JobsModule worker (C23): the timer stops and beforeApplicationShutdown waits for its blocked tick', async () => {
      const POLLS = [
        'OUTBOX_RELAY_POLL_MS', 'OUTBOX_RECONCILE_POLL_MS', 'RESERVATION_REAPER_POLL_MS', 'COUNT_SCHEDULER_POLL_MS',
        'REPLENISHMENT_SCHEDULER_POLL_MS', 'CHANNELS_SYNC_POLL_MS', 'STORAGE_SNAPSHOT_POLL_MS', 'PUSH_SENDER_POLL_MS',
        'WAVE_CUTOFF_SWEEP_POLL_MS', 'AUDIT_EXPORT_POLL_MS', 'LEDGER_INTEGRITY_POLL_MS', 'SESSION_PURGE_POLL_MS',
        'LICENCE_EXPIRY_POLL_MS',
        // Story 5-1a — the email sender.
        'EMAIL_SEND_POLL_MS',
      ];
      for (const name of POLLS) process.env[name] = '20';
      let app: INestApplication;
      try {
        app = await createApp(false);
      } finally {
        for (const name of POLLS) delete process.env[name];
      }
      const workerClasses = (Reflect.getMetadata('providers', JobsModule) as (new (...args: never[]) => unknown)[]).filter(
        (provider) => typeof provider === 'function' && /Worker$|Reaper$/.test(provider.name),
      );
      expect(workerClasses).toHaveLength(14); // 5-1a added EmailSenderWorker
      type Worker = { tick: () => Promise<unknown>; beforeApplicationShutdown: () => Promise<void> };
      const rows = workerClasses.map((cls) => {
        const worker = app.get(cls) as unknown as Worker;
        const release = deferred<void>();
        const state = { calls: 0, settled: false };
        jest.spyOn(worker, 'tick').mockImplementation(async () => {
          state.calls += 1;
          await release.promise;
          return undefined;
        });
        return { name: cls.name, worker, release, state };
      });
      resetWorkerHeartbeats();
      await app.init(); // the timers start here
      for (const row of rows) await until(() => row.state.calls === 1);
      // Story 6-2c (A3): every enabled worker registered its heartbeat under its own name.
      expect(registeredJobs().map((entry) => entry.job).sort()).toEqual([...WORKER_JOBS].sort());
      expect(registeredJobs().every((entry) => entry.inFlight)).toBe(true); // each tick is blocked: in flight

      const settling = rows.map((row) =>
        row.worker.beforeApplicationShutdown().then(() => {
          row.state.settled = true;
        }),
      );
      await pause(100);
      expect(rows.filter((row) => row.state.settled).map((row) => row.name)).toEqual([]); // each waits for its tick
      for (const row of rows) row.release.resolve();
      await Promise.all(settling);
      await pause(60); // three poll intervals: no timer may fire again
      expect(rows.filter((row) => row.state.calls !== 1).map((row) => `${row.name}: ${row.state.calls}`)).toEqual([]);
      await app.close();
    });

    it('story 6-2c: JOB_POLL_VARIABLES, WORKER_JOBS and this suite\'s POLLS are one set — each worker reads one variable and tracks one name', () => {
      const POLLS = [
        'OUTBOX_RELAY_POLL_MS', 'OUTBOX_RECONCILE_POLL_MS', 'RESERVATION_REAPER_POLL_MS', 'COUNT_SCHEDULER_POLL_MS',
        'REPLENISHMENT_SCHEDULER_POLL_MS', 'CHANNELS_SYNC_POLL_MS', 'STORAGE_SNAPSHOT_POLL_MS', 'PUSH_SENDER_POLL_MS',
        'WAVE_CUTOFF_SWEEP_POLL_MS', 'AUDIT_EXPORT_POLL_MS', 'LEDGER_INTEGRITY_POLL_MS', 'SESSION_PURGE_POLL_MS',
        'LICENCE_EXPIRY_POLL_MS', 'EMAIL_SEND_POLL_MS',
      ];
      expect([...POLLS].sort()).toEqual([...JOB_POLL_VARIABLES].sort());
      // Names ↔ variables, from the source: per worker class, the variable its constructor parses and the name it tracks.
      const source = readFileSync(join(__dirname, '..', 'src', 'jobs', 'jobs.module.ts'), 'utf8');
      const pairs = source
        .split(/\n@Injectable\(\)\nexport class /)
        .slice(1)
        .map((body) => [/this\.pollMs = parse\w+\(process\.env\.([A-Z_]+)\)/.exec(body)?.[1], /this\.ticks\.track\('([a-z-]+)'/.exec(body)?.[1]] as const)
        .filter(([variable, job]) => variable !== undefined || job !== undefined);
      expect(pairs).toHaveLength(14);
      expect(pairs.every(([variable, job]) => variable !== undefined && job !== undefined)).toBe(true);
      expect(pairs.map(([variable]) => variable).sort()).toEqual([...JOB_POLL_VARIABLES].sort());
      expect(pairs.map(([, job]) => job).sort()).toEqual([...WORKER_JOBS].sort());
    });

    it('the worker exposes the hook Nest calls before the server closes', () => {
      expect(typeof OutboxRelayWorker.prototype.beforeApplicationShutdown).toBe('function');
    });

    it('the worker role (story 6-2c): no API listener, /health/worker 200, SIGTERM exits 0', async () => {
      let port = 0;
      for (;;) {
        port = 25_000 + Math.floor(Math.random() * 4_000);
        const free = await new Promise<boolean>((resolve) => {
          const probe = net.createServer();
          probe.once('error', () => resolve(false));
          probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
        });
        if (free) break;
      }
      const child = spawn('bun', ['--no-env-file', 'src/main.ts'], {
        cwd: join(__dirname, '..'),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          WMS_PROCESS_ROLE: 'worker',
          PORT: String(port),
          OUTBOX_RELAY_POLL_MS: '200',
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          DATABASE_AUTH_URL: process.env.DATABASE_AUTH_URL ?? '',
          VALKEY_URL: process.env.VALKEY_URL ?? '',
          MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY ?? '',
          JWT_SECRET: 'shutdown-spec-jwt-secret-0123456789',
        },
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      try {
        let health: { status: number; body: string } | undefined;
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          health = await get(port, '/api/v1/health/worker').catch(() => undefined);
          if (health?.status === 200) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(health?.status).toBe(200);
        expect(JSON.parse(health!.body)).toMatchObject({ status: 'ok', jobs: [{ job: 'outbox-relay', pollMs: 200 }] });
        expect((await get(port, '/api/v1/tenants/me')).status).toBe(404); // health only: no API on the worker
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      expect(output).toMatch(/wms-be worker running outbox-relay/);
    });
  });
});
