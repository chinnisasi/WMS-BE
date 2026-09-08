import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';

@ApiTags('health')
@Controller('health')
export class HealthController {
  /** Liveness probe — answers only when the api shell is up. */
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  health(): { status: 'ok'; service: string; time: string } {
    return { status: 'ok', service: 'wms-be', time: nowIso() };
  }
}