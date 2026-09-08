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
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

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
