import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { TenantSession, DeviceSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { PutawayFacade } from '../modules/putaway/putaway.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  PlacePutawayDto,
  PutawayPlacementListQuery,
  PutawayPlacementListResponse,
  PutawayPlacementResponse,
  PutawayTaskListQuery,
  PutawayTaskListResponse,
} from '../modules/putaway/putaway.dto';

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
 * The putaway HTTP surface (Story 3.5): the device-side `putaway.place`
 * route (badge-in session — the `grn.submit` pattern; mutations are
 * device-token-only, web stays read-only) and the web-side reads (the
 * derived tasks + the placements list). The api shell is the only HTTP
 * surface of the monolith; every mutation goes through `PutawayFacade`,
 * whose command re-evaluates device status / operator role against the DB
 * at entry — the token is transport, never authority.
 */
@ApiTags('putaway')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class PutawayController {
  constructor(@Inject(PutawayFacade) private readonly putaway: PutawayFacade) {}

  @Post(':tenantId/putaway/placements')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'putaway.place — records a directed placement exactly once (badge-in session required): a putaway.placed ledger movement moves the stock from the system Receiving bin into the target bin; the suggestion is re-derived server-side and a mismatch reason is required when the operator placed elsewhere',
  })
  @ApiBody({ type: PlacePutawayDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: PutawayPlacementResponse,
    description:
      'Placement recorded: the placement snapshot with suggestion-vs-actual (the idempotency snapshot — a replay re-serves it, nothing re-moves)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a system target bin (validation-failed naming the bin), a blocked bin (bin-blocked naming the bin), a full bin (bin-full naming the bin, its capacity and occupancy), an over-place (validation-failed naming the remaining quantity), a missing/malformed mismatch reason, or a serial-arm violation (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator lacks putaway.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, GRN line, SKU, batch, or bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict), or a serial-tracked placement scans a serial that already lives in a bin or was last seen in another bin (duplicate-serial / serial-elsewhere, naming it)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or a diverged replay would drive the Receiving bin below zero (insufficient-on-hand — quarantined, never corrupting)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async placePutaway(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: PlacePutawayDto,
  ): Promise<PutawayPlacementResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.putaway.placePutaway(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        grnId: dto.grnId,
        grnLineId: dto.grnLineId,
        skuId: dto.skuId,
        batchId: dto.batchId ?? null,
        qty: dto.qty,
        toBinId: dto.toBinId,
        reasonCode: dto.reasonCode ?? null,
        occurredAt: dto.occurredAt,
        serials: dto.serials,
      },
      key,
    );
    return { placement: { ...snapshot.placement } };
  }

  @Get(':tenantId/putaway/tasks')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The derived putaway tasks: one per GRN line whose applied stock still sits in the warehouse\'s system Receiving bin, each with the capacity-only suggested bin (derived on read — no task store)',
  })
  @ApiOkResponse({
    type: PutawayTaskListResponse,
    description: 'The derived tasks (oldest receipt first) with suggested bins',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listPutawayTasks(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: PutawayTaskListQuery,
  ): Promise<PutawayTaskListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(query.warehouseId, 'warehouseId');
    const tasks = await this.putaway.getPutawayTasks(tenantId, query.warehouseId);
    return {
      items: tasks.map((task) => ({
        ...task,
        suggestedBin: task.suggestedBin === null ? null : { ...task.suggestedBin },
      })),
    };
  }

  @Get(':tenantId/putaway/placements')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists putaway placements (keyset cursor pagination, warehouse-filterable — the read-only web surface)',
  })
  @ApiOkResponse({
    type: PutawayPlacementListResponse,
    description: 'The placement page (newest first, suggestion-vs-actual carried)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), malformed warehouseId, or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listPlacements(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: PutawayPlacementListQuery,
  ): Promise<PutawayPlacementListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    const page = await this.putaway.listPlacements(tenantId, {
      warehouseId: query.warehouseId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }
}

/** Putaway uuid query params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" parameter must be a uuid (got "${value}").`,
    );
  }
}

function badgeInRequired(): ProblemException {
  return new ProblemException(
    'unauthenticated',
    401,
    'Badge-in required',
    'This endpoint requires an operator badge-in session.',
  );
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