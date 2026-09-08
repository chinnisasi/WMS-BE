import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';

@ApiTags('echo')
@Controller('echo')
export class EchoController {
  /** Round-trip endpoint used to prove the OpenAPI → typed-client pipeline. */
  @Post()
  @ApiOperation({ summary: 'Echoes the request payload back with a timestamp' })
  echo(
    @Body() body: Record<string, unknown>,
  ): { echoed: Record<string, unknown>; time: string } {
    return { echoed: body, time: nowIso() };
  }
}