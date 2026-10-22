import { Controller, Get } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { nowIso } from '../shared/primitives/time';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { READINESS_CHECKS } from './readiness.service';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- a DI token: the class must exist at run time
import { ReadinessService } from './readiness.service';
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

export class ReadinessResponse {
  @ApiProperty({ enum: ['ready'], example: 'ready' })
  status!: 'ready';

  @ApiProperty({
    example: '0087_receipt_line_condition',
    description:
      "The applied migration's tag, matched by its journal `when`; when the database is AHEAD of this image (old tasks during a roll), this image's newest tag",
  })
  migration!: string;
}

@ApiTags('health')
@ApiExtraModels(ProblemDetailsDto)
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

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

  /**
   * Story 6-2a — readiness (decision 6, A2): may this task take traffic.
   * Unauthenticated and tenant-free; a failure names its checks only
   * (`extensions.failing`), the reasons go to the log.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Ready when both Postgres pools answer, Valkey answers PING, and the database has applied at least the ' +
      "migrations this image bundles (at or after — a database ahead of the image stays ready). 503 `not-ready` " +
      `names the failing checks in \`failing\`, each one of: ${READINESS_CHECKS.join(', ')}.`,
  })
  @ApiOkResponse({ type: ReadinessResponse })
  @ApiResponse({ status: 503, ...problemJsonResponse('Not ready (not-ready) — `failing` names the checks') })
  async ready(): Promise<ReadinessResponse> {
    const result = await this.readiness.check();
    if (!result.ready) {
      throw new ProblemException('not-ready', 503, 'Not ready', `Not ready: ${result.failing.join(', ')}`, {
        failing: result.failing,
      });
    }
    return { status: 'ready', migration: result.migration };
  }
}
