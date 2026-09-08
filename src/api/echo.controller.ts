import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';

export class EchoResponse {
  @ApiProperty({ type: 'object', additionalProperties: true })
  echoed!: Record<string, unknown>;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  time!: string;
}

@ApiTags('echo')
@Controller('echo')
export class EchoController {
  /** Round-trip endpoint used to prove the OpenAPI → typed-client pipeline. */
  @Post()
  @ApiOperation({ summary: 'Echoes the request payload back with a timestamp' })
  @ApiOkResponse({ type: EchoResponse })
  echo(@Body() body: Record<string, unknown>): EchoResponse {
    return { echoed: body, time: nowIso() };
  }
}