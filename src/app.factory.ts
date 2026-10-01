import type { INestApplication} from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { OpenApiDocumentHolder } from './api/openapi-document.holder';

export const API_PREFIX = 'api/v1';

/**
 * Builds the configured application: global prefix, validation, problem-details
 * filter (via SharedModule), and the versioned OpenAPI document.
 *
 * `withListener` is false for tests and the OpenAPI export script.
 */
export async function createApp(withListener = false): Promise<INestApplication> {
  // Story 7.2 (RD-5): `rawBody: true` buffers every JSON request a second
  // time (req.rawBody) so the channel webhook signatures can be verified
  // over the EXACT bytes the provider signed — a re-serialized body would
  // not re-hash. Deliberately accepted app-wide cost (the spec's record).
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'], rawBody: true });

  // CORS: the web client runs on its own origin (dev: localhost:3001) and
  // talks to this API cross-origin with a bearer token — an allow-list, not a
  // wildcard (auth rides the Authorization header, so no cookies/credentials).
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: corsOrigins });

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
    await app.listen(parsePort(process.env.PORT));
  }
  return app;
}

export function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT "${raw ?? ''}" — must be an integer between 1 and 65535`);
  }
  return port;
}
