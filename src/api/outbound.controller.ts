import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import type { ListOrdersQuery } from '../modules/outbound/outbound.facade';
import type { OrderLineDto } from '../modules/outbound/outbound.dto';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelOrderDto,
  CreateOrderDto,
  OrderListQuery,
  OrderListResponse,
  OrderResponse,
} from '../modules/outbound/outbound.dto';

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
 * The outbound HTTP surface (Story 4.1): manual order entry, ingested-order
 * ingestion, cancellation, and the order reads — the api shell is the only
 * HTTP surface of the monolith, and every order mutation goes through
 * `OutboundFacade` (the command services re-evaluate the role against the
 * DB at entry). Backend-only in this story: the FE surface is story 4.2 (the
 * FE re-runs `api:generate` after merge).
 */
@ApiTags('outbound')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class OutboundController {
  constructor(@Inject(OutboundFacade) private readonly outbound: OutboundFacade) {}

  @Post(':tenantId/outbound/orders')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates an order (orders.manage) — manual entry or an ingested channel payload; acceptance reserves ATP per line (shortfall lines go backordered)',
  })
  @ApiBody({ type: CreateOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: OrderResponse,
    description:
      'Order accepted with per-line reserved / shortfall quantities (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks orders.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or a line\'s SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict), or a concurrent first delivery of the same channel payload (conflict — retry to read the settled result)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the channel ref already created a DIFFERENT payload (order-source-conflict)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The atomic-decision store is unreachable — the creation fails closed, nothing written (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createOrder(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateOrderDto,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.createOrder(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        source: dto.source ?? 'manual',
        lines: dto.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
        ...(dto.source === 'ingested'
          ? { integrationId: dto.integrationId, externalEventId: dto.externalEventId }
          : {}),
      },
      key,
    );
    return { order: { ...snapshot.order, lines: snapshot.order.lines.map(toLineDto) } };
  }

  @Post(':tenantId/outbound/orders/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels an accepted order (orders.manage) — every open per-line reservation is released; idempotent on replay and on an already-cancelled order',
  })
  @ApiBody({ type: CancelOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: OrderResponse,
    description: 'The cancelled order (per-line holds released; the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks orders.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Order does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A consuming flow already claimed a hold (conflict), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The reservation store is unreachable (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async cancelOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.cancelOrder(
      { tenantId, actorUserId: session.userId, orderId },
      key,
    );
    return { order: { ...snapshot.order, lines: snapshot.order.lines.map(toLineDto) } };
  }

  @Get(':tenantId/outbound/orders/:orderId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One order's detail — per line the ordered / reserved / shortfall quantities and the hold's live state",
  })
  @ApiOkResponse({
    type: OrderResponse,
    description:
      'The order with its lines (oldest first); a cancelled order keeps its per-line release truth queryable',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed orderId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No order with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async getOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) path param is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(orderId, 'orderId');
    const order = await this.outbound.getOrder(tenantId, orderId);
    if (order === null) {
      throw orderNotFound(orderId);
    }
    return { order: { ...order, lines: order.lines.map(toLineDto) } };
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/orders')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists one warehouse's orders, newest first (keyset cursor pagination)" })
  @ApiOkResponse({
    type: OrderListResponse,
    description: "The warehouse's order page (headers only — the detail read carries the lines; keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor or out-of-range limit (invalid-cursor / validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listOrders(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OrderListQuery,
  ): Promise<OrderListResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) warehouseId is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(warehouseId, 'warehouseId');
    const listQuery: ListOrdersQuery = {
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.outbound.listOrders(tenantId, warehouseId, listQuery);
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }
}

/** One line serialized for the wire (the facade's snapshot fields, verbatim). */
function toLineDto(line: OrderLineDto): OrderLineDto {
  return { ...line };
}

/** Outbound uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'orderId' | 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    `No order with id "${orderId}" exists in this tenant.`,
  );
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