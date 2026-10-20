import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { LicenceFacade, type LicenceListItem } from '../modules/compliance/licence.facade';
import type { LicenceSnapshot } from '../modules/compliance/licence.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AddLicenceDto,
  CoverageGapsResponse,
  EditLicenceDto,
  LicenceListQuery,
  LicenceListResponse,
  LicenceResponse,
} from './licences.dto';
import type { LicenceDto, LicenceListItemDto } from './licences.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session — an operator surface (role-denied)';
const WRITE_403 = 'Session belongs to another tenant (permission-denied), the caller lacks licences.manage — owner-only (role-denied), or a client-portal session (role-denied)';
const CONFLICT_409 = 'a concurrent request with the same Idempotency-Key (conflict)';

/**
 * Story 1-6c — the drug and FSSAI licences: the list and the coverage gaps
 * (any staff session — a client-portal token is refused by
 * `TenantSessionGuard`, 403 `role-denied`), and the owner's add, edit and
 * withdraw (`licences.manage`). Holds no rules — `LicenceCommand` owns
 * authority, replay and every shape rule; this maps DTOs.
 */
@ApiTags('compliance')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class LicencesController {
  constructor(@Inject(LicenceFacade) private readonly licences: LicenceFacade) {}

  // The literal `coverage` segment is declared before every `:licenceId`
  // route (IMPLEMENTATION-GUIDE §6, route declaration order).
  @Get(':tenantId/licences/coverage')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Coverage gaps — wherever a client has drug or food goods at a site (on hand, or on an open PO or ASN), each need requires a client licence (for that site or for no site) and a site licence, valid today (IST). The tenant’s own goods need only the site licence',
  })
  @ApiOkResponse({ type: CoverageGapsResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async coverage(@Param('tenantId') tenantId: string, @CurrentSession() session: TenantSession): Promise<CoverageGapsResponse> {
    assertOwnTenant(session, tenantId);
    const result = await this.licences.coverageGaps(tenantId);
    return {
      asOfDate: result.asOfDate,
      gaps: result.gaps.map((gap) => ({
        holder: gap.holder,
        ...(gap.clientId === undefined ? {} : { clientId: gap.clientId }),
        warehouseId: gap.warehouseId,
        need: gap.need,
        coveredBy: [...gap.coveredBy],
        skuCount: gap.skuCount,
      })),
    };
  }

  @Get(':tenantId/licences')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's drug and FSSAI licences — active first, then by validUntil — each with the server's expiry badge for today (IST). At most 500",
  })
  @ApiOkResponse({ type: LicenceListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId or warehouseId, or a status off the list (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: LicenceListQuery,
  ): Promise<LicenceListResponse> {
    assertOwnTenant(session, tenantId);
    const result = await this.licences.listLicences(tenantId, {
      ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
      ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { asOfDate: result.asOfDate, items: result.items.map(toListItemDto) };
  }

  @Post(':tenantId/licences')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Adds a licence (owner-only, licences.manage): a client licence (clientId, optionally a warehouseId — its premises) or a site licence (warehouseId only)',
  })
  @ApiBody({ type: AddLicenceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: LicenceResponse, description: 'The added licence (a matching Idempotency-Key replays it)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, no holder, the tenant’s own client as holder, a kind off the list, a number that breaks its kind’s rule, a malformed date, no validUntil on an FSSAI or NDPS licence, validUntil before validFrom, or a note over 200 characters (validation-failed, naming the field)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client, or no warehouse, with this id in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      `An active licence of the same family already carries this number (licence-number-taken), the client has departed (client-departed), or ${CONFLICT_409}`,
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async add(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AddLicenceDto,
  ): Promise<LicenceResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.licences.addLicence(
      {
        tenantId,
        actorUserId: session.userId,
        clientId: dto.clientId ?? null,
        warehouseId: dto.warehouseId ?? null,
        kind: dto.kind,
        number: dto.number,
        validFrom: dto.validFrom ?? null,
        validUntil: dto.validUntil ?? null,
        note: dto.note ?? null,
      },
      key,
    );
    return { licence: toLicenceDto(snapshot.licence) };
  }

  @Patch(':tenantId/licences/:licenceId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Edits a licence (owner-only, licences.manage): an absent field is kept, null clears it (never the number). Kind, client and site are fixed — a correction is a withdraw plus a new add. A changed validUntil that leaves the warned state resolves the open expiry warning (renewed). An unchanged edit is a no-op (nothing written or audited; the key is stored)',
  })
  @ApiBody({ type: EditLicenceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: LicenceResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, a malformed licenceId, a null number, a field that breaks its rule on the merged licence — clearing validUntil on an FSSAI or NDPS licence included — or a kind, clientId or warehouseId in the body (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No licence with this id in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      `The licence is withdrawn (licence-withdrawn), another active licence of the family carries the number (licence-number-taken), or ${CONFLICT_409}`,
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'licenceId', format: 'uuid' })
  async edit(
    @Param('tenantId') tenantId: string,
    @Param('licenceId') licenceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: EditLicenceDto,
  ): Promise<LicenceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('licenceId', licenceId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.licences.editLicence(
      {
        tenantId,
        actorUserId: session.userId,
        licenceId,
        // Absent (undefined) keeps, null clears — passed through as sent.
        number: dto.number,
        validFrom: dto.validFrom,
        validUntil: dto.validUntil,
        note: dto.note,
      },
      key,
    );
    return { licence: toLicenceDto(snapshot.licence) };
  }

  @Post(':tenantId/licences/:licenceId/withdraw')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Withdraws a licence (owner-only, licences.manage) — never deleted; its number is free again and its open expiry warning resolves (withdrawn)',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: LicenceResponse, description: 'The withdrawn licence (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed licenceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No licence with this id in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`The licence is already withdrawn (licence-withdrawn), or ${CONFLICT_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'licenceId', format: 'uuid' })
  async withdraw(
    @Param('tenantId') tenantId: string,
    @Param('licenceId') licenceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<LicenceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('licenceId', licenceId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.licences.withdrawLicence({ tenantId, actorUserId: session.userId, licenceId }, key);
    return { licence: toLicenceDto(snapshot.licence) };
  }
}

function toLicenceDto(licence: LicenceSnapshot): LicenceDto {
  return {
    id: licence.id,
    holder: licence.clientId === null ? 'site' : 'client',
    clientId: licence.clientId,
    warehouseId: licence.warehouseId,
    kind: licence.kind,
    number: licence.number,
    validFrom: licence.validFrom,
    validUntil: licence.validUntil,
    note: licence.note,
    status: licence.status,
    createdAt: licence.createdAt,
    updatedAt: licence.updatedAt,
  };
}

function toListItemDto(item: LicenceListItem): LicenceListItemDto {
  return { ...toLicenceDto(item), expiryState: item.expiryState, daysLeft: item.daysLeft };
}

function assertUuidParam(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}
