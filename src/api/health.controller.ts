import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';

export class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'wms-be' })
  service!: string;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  time!: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  /** Liveness probe — answers only when the api shell is up. */
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  @ApiOkResponse({ type: HealthResponse })
  health(): HealthResponse {
    return { status: 'ok', service: 'wms-be', time: nowIso() };
  }
}