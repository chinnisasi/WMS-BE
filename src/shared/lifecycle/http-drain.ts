import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- a DI token: the class must exist at run time
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { settleBefore, shutdownDrainDeadline } from './shutdown';

/**
 * Story 6-2a (A1) — the HTTP half of the drain. In `onModuleDestroy` the
 * listener stops accepting connections; in `beforeApplicationShutdown` the
 * requests already in flight are awaited, up to the shared drain deadline.
 * A new request on a kept-alive connection is answered 503 from
 * `prepareClose` on (`return503OnClosing`), and `dispose` then closes the
 * server, destroying any socket left (`forceCloseConnections`).
 */
@Injectable()
export class HttpDrain implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('HttpDrain');
  private inFlight = 0;
  private idle: (() => void) | undefined;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  private server(): Server | undefined {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.() as Server | undefined;
    return server !== undefined && typeof server.on === 'function' ? server : undefined;
  }

  onApplicationBootstrap(): void {
    this.server()?.on('request', (_req: IncomingMessage, res: ServerResponse) => {
      this.inFlight += 1;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.inFlight -= 1;
        if (this.inFlight === 0) this.idle?.();
      };
      res.once('finish', finish);
      res.once('close', finish);
    });
  }

  /** The requests currently being served (test seam). */
  get inFlightRequests(): number {
    return this.inFlight;
  }

  /**
   * The first hook of the sequence (after `prepareClose`): stop accepting
   * connections at once, before any module waits on anything. The callback
   * fires only once every connection is gone, which `dispose` arranges — it
   * is never awaited here.
   */
  onModuleDestroy(): void {
    const server = this.server();
    if (server?.listening) {
      server.close(() => undefined);
      server.closeIdleConnections?.();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.inFlight === 0) return;
    const drained = new Promise<void>((resolve) => {
      this.idle = resolve;
    });
    const settled = await settleBefore(drained, shutdownDrainDeadline());
    if (!settled) {
      this.logger.warn(`${this.inFlight} request(s) still in flight at the drain deadline — their sockets will be closed`);
    }
  }
}
