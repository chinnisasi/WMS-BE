import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { InFlightTick } from '../src/shared/lifecycle/shutdown';
import { WorkerHealthServer, workerHealthReply } from '../src/shared/lifecycle/worker-health-server';
import {
  heartbeatClock,
  LOOP_DEAD_SLACK_MS,
  markWorkerRegistrationComplete,
  resetWorkerHeartbeats,
} from '../src/shared/lifecycle/worker-heartbeat';

/**
 * Story 6-2c (decision 6, A10, A11) — the worker role's health-only
 * listener: two routes, everything else 404, `problem()` bodies, `not-ready`
 * until `main.ts` marks the registration complete, closed on shutdown.
 */
const realNow = heartbeatClock.now;

/** A port outside the OS ephemeral range (the suites' stable-ports rule), free right now. */
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

function get(port: number, path: string): Promise<{ status: number; type: string | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the worker health listener (story 6-2c)', () => {
  let now = 0;
  const savedRole = process.env.WMS_PROCESS_ROLE;
  const savedPort = process.env.PORT;

  beforeEach(() => {
    resetWorkerHeartbeats();
    now = Date.parse('2026-10-23T10:00:00.000Z');
    heartbeatClock.now = () => now;
  });

  afterEach(() => {
    heartbeatClock.now = realNow;
    resetWorkerHeartbeats();
    if (savedRole === undefined) delete process.env.WMS_PROCESS_ROLE;
    else process.env.WMS_PROCESS_ROLE = savedRole;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  describe('the replies', () => {
    it('before registration completes: 503 not-ready (A10)', () => {
      new InFlightTick().track('outbox-relay', 2_000);
      expect(workerHealthReply('GET', '/api/v1/health/worker', now)).toEqual({
        status: 503,
        contentType: 'application/problem+json',
        body: {
          type: 'https://wms.example.com/problems/not-ready',
          title: 'Not ready',
          status: 503,
          code: 'not-ready',
          detail: 'Not ready: worker-registration',
          failing: ['worker-registration'],
        },
      });
    });

    it('all fresh: 200 with every registered job (A11 — lastProgressAt, no lastTickAt)', () => {
      const relay = new InFlightTick();
      relay.track('outbox-relay', 2_000);
      new InFlightTick().track('session-purge', 86_400_000);
      markWorkerRegistrationComplete();
      relay.start(() => new Promise(() => undefined));
      const reply = workerHealthReply('GET', '/api/v1/health/worker?x=1', now + 1_000);
      expect(reply).toEqual({
        status: 200,
        contentType: 'application/json',
        body: {
          status: 'ok',
          jobs: [
            {
              job: 'outbox-relay',
              pollMs: 2_000,
              inFlight: true,
              lastStartedAt: '2026-10-23T10:00:00.000Z',
              lastProgressAt: '2026-10-23T10:00:00.000Z',
              noProgressMs: 1_200_000,
            },
            {
              job: 'session-purge',
              pollMs: 86_400_000,
              inFlight: false,
              lastStartedAt: null,
              lastProgressAt: '2026-10-23T10:00:00.000Z',
              noProgressMs: 1_200_000,
            },
          ],
        },
      });
    });

    it('a stale job: the pinned 503 worker-stale problem naming it in `failing` (A11)', () => {
      new InFlightTick().track('outbox-relay', 2_000);
      new InFlightTick().track('session-purge', 86_400_000);
      markWorkerRegistrationComplete();
      // The relay's timer is gone: nothing started for pollMs + 60 s + 1 ms.
      expect(workerHealthReply('GET', '/api/v1/health/worker', now + 2_000 + LOOP_DEAD_SLACK_MS + 1)).toEqual({
        status: 503,
        contentType: 'application/problem+json',
        body: {
          type: 'https://wms.example.com/problems/worker-stale',
          title: 'Worker stale',
          status: 503,
          code: 'worker-stale',
          detail: 'Stale: outbox-relay',
          failing: ['outbox-relay'],
        },
      });
    });

    it('AC "hung job": a tick that never settles nor beats is 503 exactly once its noProgressMs passes, and not before', () => {
      const hung = new InFlightTick();
      hung.track('wave-cutoff-sweep', 60_000);
      markWorkerRegistrationComplete();
      hung.start(() => new Promise(() => undefined));
      expect(workerHealthReply('GET', '/api/v1/health/worker', now + 1_200_000).status).toBe(200);
      const late = workerHealthReply('GET', '/api/v1/health/worker', now + 1_200_001);
      expect(late.status).toBe(503);
      expect(late.body).toMatchObject({ code: 'worker-stale', failing: ['wave-cutoff-sweep'] });
    });

    it('/api/v1/health answers the API liveness body', () => {
      const reply = workerHealthReply('GET', '/api/v1/health', now);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ status: 'ok', service: 'wms-be' });
    });

    it.each([
      ['GET', '/api/v1/tenants/me'],
      ['GET', '/'],
      ['POST', '/api/v1/health/worker'],
      ['GET', '/api/v1/health/ready'],
      ['GET', '/api/v1/openapi.json'],
    ])('%s %s: 404 — the worker serves no API', (method, path) => {
      const reply = workerHealthReply(method, path, now);
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: 'not-found', status: 404 });
    });
  });

  describe('the provider', () => {
    it('in the worker role it listens on PORT, answers both routes and 404, and closes in onModuleDestroy', async () => {
      const port = await freePort();
      process.env.WMS_PROCESS_ROLE = 'worker';
      process.env.PORT = String(port);
      heartbeatClock.now = realNow;
      new InFlightTick().track('outbox-relay', 2_000);
      const server = new WorkerHealthServer();
      await server.onApplicationBootstrap();
      try {
        expect(server.address).toMatchObject({ address: '0.0.0.0', port });
        expect((await get(port, '/api/v1/health/worker')).status).toBe(503); // registration not complete
        markWorkerRegistrationComplete();
        const ok = await get(port, '/api/v1/health/worker');
        expect(ok.status).toBe(200);
        expect(ok.type).toBe('application/json');
        expect(ok.body).toMatchObject({ status: 'ok', jobs: [{ job: 'outbox-relay' }] });
        expect((await get(port, '/api/v1/health')).status).toBe(200);
        const notFound = await get(port, '/api/v1/tenants/me');
        expect(notFound.status).toBe(404);
        expect(notFound.type).toBe('application/problem+json');
      } finally {
        await server.onModuleDestroy();
      }
      await expect(get(port, '/api/v1/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('in the api role (the default) it never listens', async () => {
      delete process.env.WMS_PROCESS_ROLE;
      const server = new WorkerHealthServer();
      await server.onApplicationBootstrap();
      expect(server.address).toBeUndefined();
      await server.onModuleDestroy();
    });

    it('EADDRINUSE rejects the bootstrap hook (so app.init() rejects and main exits 1)', async () => {
      const port = await freePort();
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(port, '0.0.0.0', () => resolve()));
      try {
        process.env.WMS_PROCESS_ROLE = 'worker';
        process.env.PORT = String(port);
        await expect(new WorkerHealthServer().onApplicationBootstrap()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });
  });
});
