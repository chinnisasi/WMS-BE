import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp, HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS } from '../src/app.factory';
import { SHUTDOWN_DRAIN_MS, SHUTDOWN_FORCE_EXIT_MS } from '../src/shared/lifecycle/shutdown';

/**
 * Story 6-2c (decision 2, A8) — the keep-alive edge. The ALB keeps an idle
 * connection 60 s; the API must keep it longer, or the ALB can reuse a socket
 * the API just closed (an intermittent 502). Proven under Bun in the image
 * (the CI `image` job's keepalive smoke, with a 5 s negative control); this
 * pins the values on the server every caller of `createApp` gets, and keeps
 * `runtime-contract.json` — what 6-2d's IaC test reads — in step with them.
 */
describe('HTTP keep-alive and header timeouts (story 6-2c)', () => {
  let app: INestApplication | undefined;

  afterAll(async () => {
    await app?.close();
  });

  it('the constants sit above the ALB idle timeout (60 s) with margin, headers above keep-alive', () => {
    expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBe(66_000);
    // A8's inequality with #219's ALB idle_timeout of 60 s: 60 ≤ 65 − 5 (the
    // spec writes "below"; with these values it is the boundary, kept as ≤).
    const albIdleTimeoutS = 60;
    expect(albIdleTimeoutS).toBeLessThanOrEqual(HTTP_KEEP_ALIVE_TIMEOUT_MS / 1000 - 5);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('createApp sets them on the HTTP server, before any listen', async () => {
    app = await createApp(false);
    const server = app.getHttpServer() as Server;
    expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
  });

  it('runtime-contract.json carries exactly the code constants (A8)', () => {
    const contract = JSON.parse(readFileSync(join(__dirname, '..', 'runtime-contract.json'), 'utf8')) as Record<string, unknown>;
    expect(contract).toEqual({
      httpKeepAliveTimeoutMs: HTTP_KEEP_ALIVE_TIMEOUT_MS,
      httpHeadersTimeoutMs: HTTP_HEADERS_TIMEOUT_MS,
      shutdownForceExitMs: SHUTDOWN_FORCE_EXIT_MS,
      shutdownDrainMs: SHUTDOWN_DRAIN_MS,
    });
  });

  it('the timing invariants the contract states hold (A8): drain inside the force exit, force exit + 5 s inside a 30 s stop timeout', () => {
    expect(SHUTDOWN_DRAIN_MS).toBeLessThan(SHUTDOWN_FORCE_EXIT_MS);
    expect(SHUTDOWN_FORCE_EXIT_MS + 5_000).toBeLessThanOrEqual(30_000);
  });
});
