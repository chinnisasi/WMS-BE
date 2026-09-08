import { Controller, Get } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';

export class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'wms-be' })
  service!: string;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  time!: string;
}

@ApiTags('health')
@ApiExtraModels(ProblemDetailsDto)
@Controller('health')
export class HealthController {
  /** Liveness probe — answers only when the api shell is up. */
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  @ApiOkResponse({ type: HealthResponse })
  @ApiResponse({
    status: 404,
    ...problemJsonResponse('Route not found'),
  })
  @ApiResponse({
    status: 500,
    ...problemJsonResponse('Internal error'),
  })
  health(): HealthResponse {
    return { status: 'ok', service: 'wms-be', time: nowIso() };
  }
}
