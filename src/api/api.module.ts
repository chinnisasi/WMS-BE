import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { EchoController } from './echo.controller';
import { OpenApiController } from './openapi.controller';
import { NotFoundController } from './not-found.controller';
import { OpenApiDocumentHolder } from './openapi-document.holder';

/**
 * api shell: the only HTTP surface of the monolith. Story 1.1 exposes
 * health, echo, and the versioned OpenAPI document — nothing else.
 */
@Module({
  controllers: [HealthController, EchoController, OpenApiController, NotFoundController],
  providers: [OpenApiDocumentHolder],
})
export class ApiModule {}