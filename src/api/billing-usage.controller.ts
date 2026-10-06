import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { BillingFacade } from '../modules/billing/billing.facade';
import { ClientUsageResponse } from './billing-usage.dto';
import { IsIsoDate } from './rate-cards.dto';

/**
 * The usage query, declared beside the route (the `RateCardInForceQuery`
 * precedent): `@Query()` needs the class as a VALUE for the validation
 * pipe's `design:paramtypes` metadata. It checks SHAPE only (a real
 * `YYYY-MM-DD`); `from ≤ to` and the 366-day bound are the metering read's
 * own rules (one copy, behind the facade — 21-5 inherits them), answered
 * 400 `validation-failed` before anything is read.
 */
export class ClientUsageQuery {
  @ApiProperty({ example: '2026-09-01', description: 'First IST date of the period (inclusive), YYYY-MM-DD' })
  @IsIsoDate()
  from!: string;

  @ApiProperty({
    example: '2026-09-30',
    description: 'Last IST date of the period (inclusive), YYYY-MM-DD — at most 366 days after `from`, never before it',
  })
  @IsIsoDate()
  to!: string;
}


/**
 * Story 21-4 — a client's metered usage (FR-78, CAP-5): for an inclusive IST
 * date period, each charge's quantity per rate-card segment, with its rate
 * and amount (GST-exclusive) — an ESTIMATE until 21-5 invoices it. Member-open,
 * like the rate cards it prices with (every member already reads them).
 * The 21-7 client portal must NOT reuse this route: it is an operator read
 * of commercial terms, scoped by the operator session only. Holds no rules —
 * the period rules and the client check are the metering read's.
 */
@ApiTags('billing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class BillingUsageController {
  constructor(@Inject(BillingFacade) private readonly facade: BillingFacade) {}

  @Get(':tenantId/clients/:clientId/usage')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "A client's metered usage over an inclusive IST date period — storage (per base UoM, through the snapshot watermark), receipt lines, picks and dispatched orders — split by the rate card in force and priced; an estimate until invoiced",
  })
  @ApiOkResponse({ type: ClientUsageResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'A malformed clientId, a `from`/`to` that is not a real YYYY-MM-DD date, `from` after `to`, or a period longer than 366 days (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session — a user with a client (role-denied): this is an operator read'),
  })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async usage(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ClientUsageQuery,
  ): Promise<ClientUsageResponse> {
    if (session.tenantId !== tenantId) {
      throw new ProblemException(
        'permission-denied',
        403,
        'Session belongs to another tenant',
        'The session token tenant does not own this path.',
      );
    }
    if (!UUID_RE.test(clientId)) {
      throw new ProblemException('validation-failed', 400, 'Malformed clientId', `clientId must be a uuid (got "${clientId}").`);
    }
    const asOf = new Date().toISOString();
    const metered = await this.facade.meterPeriod(tenantId, session.userId, clientId, query.from, query.to);
    return {
      clientId: metered.clientId,
      from: metered.fromDate,
      to: metered.toDate,
      asOf,
      storageCompleteThrough: metered.storageCompleteThrough,
      segments: metered.segments.map((segment) => ({
        rateCardId: segment.rateCardId,
        fromDate: segment.fromDate,
        toDate: segment.toDate,
        storageMeasuredThrough: segment.storageMeasuredThrough,
        lines: segment.lines.map((line) => ({ ...line })),
      })),
      totals: { ...metered.totals },
    };
  }
}
