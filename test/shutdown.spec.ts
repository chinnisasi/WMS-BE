import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { HealthController, type HealthResponse } from '../src/api/health.controller';
import { OutboxRelayWorker } from '../src/jobs/jobs.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { DatabaseLifecycle } from '../src/shared/lifecycle/database-lifecycle';
import { HttpDrain } from '../src/shared/lifecycle/http-drain';
import {
  InFlightTick,
  armForceExit,
  resetShutdownDrainDeadline,
  settleBefore,
  shutdownDrainDeadline,
} from '../src/shared/lifecycle/shutdown';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
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
      expect(settleBefore(Promise.resolve(), 0)).resolves.toBe(false);
    });

    it('armForceExit: the first signal arms a timer that exits 1 when the sequence overruns', async () => {
      const exits: number[] = [];
      const disarm = armForceExit(30, (code) => exits.push(code), ['SIGUSR2']);
      try {
        process.emit('SIGUSR2', 'SIGUSR2');
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(exits).toEqual([1]);
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

    it('the worker exposes the hook Nest calls before the server closes', () => {
      expect(typeof OutboxRelayWorker.prototype.beforeApplicationShutdown).toBe('function');
    });
  });
});
