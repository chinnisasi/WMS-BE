import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
// Value import required — the class is a DI token; a type-only import would
// drop the emitted design:paramtypes metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OpenApiDocumentHolder } from './openapi-document.holder';

/**
 * Serves the versioned OpenAPI document (AD-8). This JSON is the contract:
 * wms-fe and the mobile app generate their clients from it — no hand-written
 * API types on the consuming side.
 */
@Controller('openapi.json')
export class OpenApiController {
  constructor(private readonly holder: OpenApiDocumentHolder) {}

  @Get()
  @ApiExcludeEndpoint()
  document(@Res() res: Response): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(this.holder.get());
  }
}