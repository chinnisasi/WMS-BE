import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ExcursionFacade } from '../modules/compliance/excursion.facade';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ExcursionListQuery,
  ExcursionListResponse,
  ExcursionResponse,
  RecordExcursionDto,
} from './compliance.dto';
const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The compliance HTTP surface (Story 12-5, FR-44): the temperature-excursion
 * record/list/resolve routes. Every mutation goes through
 * `ExcursionFacade`, whose commands re-evaluate the caller's role against the
 * DB at entry (the token is transport, never authority) — recording is
 * `excursion.record` (Owner + Ops Manager + Operator), resolving is the
 * existing `review.decide`. The quarantine itself rides the inbound module's
 * QC-hold semantics inside the command; this controller holds no rules.
 */
@ApiTags('compliance')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ComplianceController {
  constructor(
    @Inject(ExcursionFacade) private readonly excursions: ExcursionFacade,
  ) {}

  @Post(':tenantId/excursions')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'excursion record — records a temperature excursion against a bin (excursion.record): quarantines every affected (sku, bin) scope through ordinary QC holds and appends one zero-quantity excursion.recorded ledger event per scope',
  })
  @ApiBody({ type: RecordExcursionDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: ExcursionResponse,
    description: 'Excursion recorded: the open row with the hold ids it created (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, an out-of-bounds readingC, an empty or system-owned bin, a bin with no on-hand stock, or serial-tracked / catch-weight stock in the bin — the whole excursion is refused naming the offenders (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks excursion.record (role-denied), or the bin is secure/cage-class and the caller — an operator recording from the floor — lacks secure.move (role-denied from the hold core; held units leave the origin bin, FR-42)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async recordExcursion(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordExcursionDto,
  ): Promise<ExcursionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.excursions.recordExcursion(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        binId: dto.binId,
        readingC: dto.readingC,
        note: dto.note ?? null,
        occurredAt: dto.occurredAt ?? null,
      },
      key,
    );
    return { excursion: { ...snapshot.excursion, holdIds: [...snapshot.excursion.holdIds] } };
  }

  @Post(':tenantId/excursions/:excursionId/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Resolves an excursion (review.decide) — the review-status flip only; the created QC holds are untouched and stock disposition stays the qc.manage release / stock.adjust verbs',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: ExcursionResponse,
    description: 'Excursion resolved: the resolved row with resolvedBy/resolvedAt (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed excursionId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No excursion with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already resolved (excursion-resolved), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'excursionId', format: 'uuid' })
  async resolveExcursion(
    @Param('tenantId') tenantId: string,
    @Param('excursionId') excursionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ExcursionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(excursionId, 'excursionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.excursions.resolveExcursion(
      { tenantId, actorUserId: session.userId, excursionId },
      key,
    );
    return { excursion: { ...snapshot.excursion, holdIds: [...snapshot.excursion.holdIds] } };
  }

  @Get(':tenantId/excursions')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists temperature excursions (keyset cursor pagination, warehouse- and status-filterable — the review queue read, open to any member)',
  })
  @ApiOkResponse({
    type: ExcursionListResponse,
    description: 'The excursion page (newest first — the Conflicts & Reviews queue read)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, warehouseId, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listExcursions(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ExcursionListQuery,
  ): Promise<ExcursionListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    const page = await this.excursions.listExcursions(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((item) => ({ ...item, holdIds: [...item.holdIds] })),
      nextCursor: page.nextCursor,
    };
  }
}

/** Excursion uuid path/query params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'excursionId' | 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" parameter must be a uuid (got "${value}").`,
    );
  }
}

function assertOwnTenantToken(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}