import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { problem } from '../problem-details/problem-details';
import { nowIso } from '../primitives/time';
import { parsePort, parseProcessRole } from './process-role';
import { heartbeatClock, isWorkerRegistrationComplete, registeredJobs, staleJobs } from './worker-heartbeat';

/**
 * Story 6-2c (decision 6, A10, A11, A17) — the worker's health-only listener.
 *
 * With `WMS_PROCESS_ROLE=worker` the Nest app has no API listener; this tiny
 * `node:http` server on `0.0.0.0:PORT` answers exactly two routes, and 404
 * to everything else (the worker serves no API):
 *
 *   GET /api/v1/health          200, the API's liveness body — so the probe
 *                               #219 already runs keeps working
 *   GET /api/v1/health/worker   200 {status:'ok', jobs:[…]} while every job
 *                               is fresh; 503 problem+json `worker-stale`
 *                               naming the stale jobs in `failing`; 503
 *                               `not-ready` until `main.ts` marks the
 *                               registration complete
 *
 * Not a Nest route, so not in the OpenAPI document. A blocked event loop
 * fails the probe too — intended: the task is then unhealthy.
 */

export const WORKER_HEALTH_PATH = '/api/v1/health/worker';
export const LIVENESS_PATH = '/api/v1/health';

const PROBLEM_JSON = 'application/problem+json';

type Reply = { status: number; contentType: string; body: unknown };

/** The response for one request (pure, so the bodies are pinned without a socket). */
export function workerHealthReply(method: string | undefined, rawUrl: string | undefined, now: number = heartbeatClock.now()): Reply {
  const path = (rawUrl ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';
  if (method === 'GET' && path === LIVENESS_PATH) {
    return { status: 200, contentType: 'application/json', body: { status: 'ok', service: 'wms-be', time: nowIso() } };
  }
  if (method === 'GET' && path === WORKER_HEALTH_PATH) {
    if (!isWorkerRegistrationComplete()) {
      return {
        status: 503,
        contentType: PROBLEM_JSON,
        body: problem('not-ready', 503, 'Not ready', 'Not ready: worker-registration', { failing: ['worker-registration'] }),
      };
    }
    const stale = staleJobs(now);
    if (stale.length > 0) {
      return {
        status: 503,
        contentType: PROBLEM_JSON,
        body: problem('worker-stale', 503, 'Worker stale', `Stale: ${stale.join(', ')}`, { failing: stale }),
      };
    }
    return {
      status: 200,
      contentType: 'application/json',
      body: {
        status: 'ok',
        jobs: registeredJobs().map((entry) => ({
          job: entry.job,
          pollMs: entry.pollMs,
          inFlight: entry.inFlight,
          lastStartedAt: entry.lastStartedAt === null ? null : new Date(entry.lastStartedAt).toISOString(),
          lastProgressAt: new Date(entry.lastProgressAt).toISOString(),
          noProgressMs: entry.noProgressMs,
        })),
      },
    };
  }
  return {
    status: 404,
    contentType: PROBLEM_JSON,
    body: problem('not-found', 404, 'Not Found', `Cannot ${method ?? 'GET'} ${path} — this worker serves health only`),
  };
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const reply = workerHealthReply(req.method, req.url);
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'Content-Type': reply.contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Creates the listener (not yet listening). */
export function createWorkerHealthServer(): Server {
  return createServer(handle);
}

/** Listens on `host:port`; rejects on a listen error (`EADDRINUSE`, …). */
export function listen(server: Server, port: number, host = '0.0.0.0'): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

/**
 * The JobsModule provider: listens only in the worker role, during
 * `app.init()` — a listen error rejects `init()` and the process exits 1
 * (A10) — and closes in `onModuleDestroy`, the first shutdown hook.
 */
@Injectable()
export class WorkerHealthServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('WorkerHealthServer');
  private server: Server | undefined;

  async onApplicationBootstrap(): Promise<void> {
    if (parseProcessRole(process.env.WMS_PROCESS_ROLE) !== 'worker') return;
    const server = createWorkerHealthServer();
    const address = await listen(server, parsePort(process.env.PORT));
    // After listen, a server error (rare: an fd limit, a socket fault) is logged, never an unhandled 'error' crash.
    server.on('error', (error: Error) => this.logger.error(`Worker health listener error: ${error.message}`));
    this.server = server;
    this.logger.log(`Worker health listener on ${address.address}:${address.port} (${LIVENESS_PATH}, ${WORKER_HEALTH_PATH})`);
  }

  /** The bound address while listening (test seam). */
  get address(): AddressInfo | undefined {
    return (this.server?.address() as AddressInfo | null) ?? undefined;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}
