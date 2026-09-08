import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import type { LedgerTimelineQuery } from '../modules/inventory/inventory.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  LedgerEventListResponse,
  LedgerEventsQuery,
  StockAdjustmentDto,
  StockAdjustmentResponse,
} from '../modules/inventory/inventory.dto';

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
 * The inventory HTTP surface (Story 2.1): the manual `stock.adjustment`
 * command and the event-timeline read — the api shell is the only HTTP
 * surface of the monolith. Every stock mutation goes through
 * `InventoryFacade`; the ledger core is not HTTP-exposed beyond these two
 * routes (replay/verify/anchor are consumed by Story 2.2, not HTTP).
 */
@ApiTags('inventory')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class InventoryController {
  constructor(
    @Inject(InventoryFacade) private readonly inventoryFacade: InventoryFacade,
  ) {}

  @Post(':tenantId/inventory/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Records a manual stock adjustment (one ledger event + on-hand projection in one commit)',
  })
  @ApiBody({ type: StockAdjustmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: StockAdjustmentResponse,
    description: 'Adjustment committed: the ledger event snapshot plus the resulting on-hand quantity',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks stock.adjust (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, bin, or SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent request on the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the movement would drive on-hand below zero (insufficient-on-hand names the bin and current on-hand)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async adjustStock(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: StockAdjustmentDto,
  ): Promise<StockAdjustmentResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.inventoryFacade.adjustStock(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        binId: dto.binId,
        quantityDelta: dto.quantityDelta,
        reasonCode: dto.reasonCode,
        note: dto.note,
        occurredAt: dto.occurredAt,
      },
      key,
    );
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/events')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's ledger event timeline (keyset cursor pagination, newest first)",
  })
  @ApiOkResponse({
    type: LedgerEventListResponse,
    description: "The warehouse's ledger event-timeline page (newest first, keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed skuId query, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listEvents(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: LedgerEventsQuery,
  ): Promise<LedgerEventListResponse> {
    assertOwnTenant(session, tenantId);
    const timelineQuery: LedgerTimelineQuery = {
      skuId: query.skuId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.inventoryFacade.listEvents(tenantId, warehouseId, timelineQuery);
    return { items: page.items, nextCursor: page.nextCursor };
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