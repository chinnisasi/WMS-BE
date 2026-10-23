import type { Server } from 'node:http';
import type { INestApplication} from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { OpenApiDocumentHolder } from './api/openapi-document.holder';

import { parsePort as parsePortFromEnv } from './shared/lifecycle/process-role';

export { parsePort } from './shared/lifecycle/process-role';

export const API_PREFIX = 'api/v1';

/**
 * Story 6-2a (A1) — the HTTP side of graceful shutdown. From the first step
 * of `close()` a new request on a kept-alive connection answers 503 with
 * `Connection: close` (`return503OnClosing`); the in-flight ones drain in
 * `HttpDrain.beforeApplicationShutdown`; and `dispose` destroys every socket
 * still open (`forceCloseConnections`), so an idle keep-alive connection
 * cannot hold `server.close()` open.
 */
export const SHUTDOWN_HTTP_OPTIONS = { forceCloseConnections: true, return503OnClosing: true } as const;

/**
 * Story 6-2c (decision 2) — the keep-alive edge. The ALB keeps an idle
 * connection to a target for 60 s; a target that closes it sooner (Node and
 * Bun default to 5 s) races the ALB, which can send a request on a socket the
 * API has just closed — an intermittent 502. The API therefore keeps idle
 * sockets for 65 s, above the ALB's idle timeout (the invariant: ALB
 * `idle_timeout` ≤ 65 − 5 — #219's 60 s is the boundary). Constants, not env vars: they are tied to the
 * ALB's value, and `runtime-contract.json` carries them for the IaC's test.
 *
 * `headersTimeout` must exceed `keepAliveTimeout` under Node (jest runs on
 * Node). Bun accepts it but does not enforce it (its own ~12 s idle timer
 * bounds an incomplete header block) — set for parity.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;

/**
 * Builds the configured application: global prefix, validation, problem-details
 * filter (via SharedModule), and the versioned OpenAPI document.
 *
 * `withListener` is false for tests, the OpenAPI export script and the
 * worker role (story 6-2c: the worker initialises the app without an API
 * listener; `main.ts`).
 */
export async function createApp(withListener = false): Promise<INestApplication> {
  // Story 7.2 (RD-5): `rawBody: true` buffers every JSON request a second
  // time (req.rawBody) so the channel webhook signatures can be verified
  // over the EXACT bytes the provider signed — a re-serialized body would
  // not re-hash. Deliberately accepted app-wide cost (the spec's record).
  // Story 6-2c (A18): `abortOnError: false` — a provider's construction error
  // (a bad *_POLL_MS → ConfigRefusal) reaches main.ts, which maps it to its
  // exit code, instead of Nest's own process.exit(1).
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true,
    abortOnError: false,
    ...SHUTDOWN_HTTP_OPTIONS,
  });
  const httpServer = app.getHttpServer() as Server;
  httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;

  // CORS: the web client runs on its own origin (dev: localhost:3001) and
  // talks to this API cross-origin with a bearer token — an allow-list, not a
  // wildcard (auth rides the Authorization header, so no cookies/credentials).
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim());
  // Story 6-1a — credentials for the allow-listed origins only: the refresh
  // cookie rides /api/v1/tenants/session (refresh, sign-out).
  app.enableCors({ origin: corsOrigins, credentials: true });

  // The OpenAPI document is built before the global prefix so its paths are
  // clean (/health) and the base path travels in `servers` instead (AD-8).
  const config = new DocumentBuilder()
    .setTitle('WMS API')
    .setDescription(
      'Warehouse Management System backend — modular monolith. ' +
        'This document is the contract: web and mobile clients generate typed clients from it (AD-8).',
    )
    .setVersion('1.0.0')
    .setContact('WMS', 'https://wms.example.com', 'api@wms.example.com')
    .setLicense('Proprietary', 'https://wms.example.com/license')
    .addServer(`/${API_PREFIX}`)
    // Bearer session scheme — the warehouse endpoints' `security` entries
    // reference this (Swagger UI can then exercise them with a sign-in token).
    .addBearerAuth()
    // Story 12.8 (UX-DR30): the device-token scheme, named because the
    // excursion record route accepts EITHER family — its `security` entry
    // lists both, and a second anonymous scheme would collide with the first.
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'device')
    .build();
  const document = SwaggerModule.createDocument(app, config);

  app.get(OpenApiDocumentHolder).set(document as unknown as Record<string, unknown>);
  // Human-readable contract browser (JSON at /api/docs/json).
  SwaggerModule.setup('api/docs', app, document);

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (withListener) {
    await app.listen(parsePortFromEnv(process.env.PORT));
  }
  return app;
}

