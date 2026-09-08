import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';

export class EchoResponse {
  @ApiProperty({ type: 'object', additionalProperties: true })
  echoed!: Record<string, unknown>;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  time!: string;
}

@ApiTags('echo')
@ApiExtraModels(ProblemDetailsDto)
@Controller('echo')
export class EchoController {
  /** Round-trip endpoint used to prove the OpenAPI → typed-client pipeline. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Echoes the request JSON object back with a timestamp' })
  @ApiBody({ schema: { type: 'object', additionalProperties: true } })
  @ApiOkResponse({ type: EchoResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse('Body is not a JSON object'),
  })
  @ApiResponse({
    status: 404,
    ...problemJsonResponse('Route not found'),
  })
  @ApiResponse({
    status: 500,
    ...problemJsonResponse('Internal error'),
  })
  echo(@Body() body: Record<string, unknown>): EchoResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Echo body must be a JSON object');
    }
    return { echoed: body, time: nowIso() };
  }
}
