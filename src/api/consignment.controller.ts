import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { ConsignmentCommand } from '../modules/invoicing/consignment.command';
// Bound to @Body() / @Query() — value imports (the ValidationPipe reads the classes).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ConsignmentRecordResponse,
  ConsignmentWithdrawResponse,
  ConsignmentWorklistQueryDto,
  ConsignmentWorklistResponse,
  OrderConsignmentResponse,
  RecordConsignmentDto,
  WithdrawConsignmentDto,
} from './consignment.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID (26 chars, Crockford base32) — replays return the original result',
    schema: { type: 'string' },
  },
];

const TENANT_PARAM = { name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' } as const;

const RECORD_409 =
  'The order is cancelled (order-not-open); the tenant’s own goods (own-goods-invoiced); the e-way number is live on another of the client’s orders (eway-bill-in-use, extensions.orderId/orderLabel); 99 versions (consignment-version-limit); no national e-way threshold in force (eway-threshold-missing)';

/**
 * Story 4-6a — the order consignment record, staff surface (A9, A10, A16):
 * record or amend the brand's tax document and e-way bill, withdraw it, read
 * it, and the warehouse's documents worklist. The portal twins live in
 * `portal.controller.ts`; the client's documents rule in `clients.controller.ts`.
 */
@ApiTags('consignment')
@Controller('tenants')
export class ConsignmentController {
  constructor(
    @Inject(ConsignmentCommand) private readonly consignment: ConsignmentCommand,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  // The literal `consignment/withdraw` is declared before any `:param`
  // sibling (guide §6 route order — the 8-2a gotcha).
  @Post(':tenantId/outbound/orders/:orderId/consignment/withdraw')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-6a — orders.manage: withdraws the order’s live consignment record (the gate refuses again); refused once the order has left' })
  @ApiBody({ type: WithdrawConsignmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ConsignmentWithdrawResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A reason outside 1–200 characters (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Missing orders.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('No live record (consignment-not-found); the order is dispatched — amend instead (order-dispatched)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The key reused with another body (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async withdraw(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: WithdrawConsignmentDto,
  ): Promise<ConsignmentWithdrawResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.consignment.withdrawConsignment({ tenantId, actorUserId: session.userId, orderId, reason: dto.reason }, key);
    return JSON.parse(JSON.stringify(snapshot)) as ConsignmentWithdrawResponse;
  }

  @Post(':tenantId/outbound/orders/:orderId/consignment')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 4-6a — dispatch.execute: records (or amends — a new version) the brand’s tax document, declared value and e-way bill for a client order; the WMS judges the e-way threshold in force on the document date. An exemption, an amendment after dispatch, or a value that drops a required bill need orders.manage (A46). The same body again is a no-op that stores the key.',
  })
  @ApiBody({ type: RecordConsignmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: 201, type: ConsignmentRecordResponse, description: 'A new version (a replay re-serves it)' })
  @ApiResponse({ status: HttpStatus.OK, type: ConsignmentRecordResponse, description: 'The body equals the live version — nothing written, the key stored (unchanged: true; a replay of the key is 200 too)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed field, a date outside its window, a missing consignor GSTIN, or an amendment after dispatch without a reason (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Missing dispatch.execute, or orders.manage for an exemption or an amendment after dispatch (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(RECORD_409) })
  @ApiResponse({ status: 422, ...problemJsonResponse('The declared value is below the COD amount (declared-value-below-order-value); the key reused (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async record(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordConsignmentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsignmentRecordResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.consignment.recordConsignment({ tenantId, actorUserId: session.userId, orderId, body: dto }, key);
    if (snapshot.unchanged === true) res.status(HttpStatus.OK);
    return JSON.parse(JSON.stringify(snapshot)) as ConsignmentRecordResponse;
  }

  @Get(':tenantId/outbound/orders/:orderId/consignment')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-6a — the order’s consignment (any staff role): the gate today, the live version and its history, the version the goods left under, the warnings and the scans' })
  @ApiOkResponse({ type: OrderConsignmentResponse })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('No national e-way threshold in force (eway-threshold-missing)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async read(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderConsignmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const view = await this.outbound.orderConsignment(tenantId, orderId);
    if (view === null) throw new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists in this tenant.`);
    return JSON.parse(JSON.stringify(view)) as OrderConsignmentResponse;
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/consignments')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 4-6a — the documents worklist (any staff role): needed — open orders whose brand documents block them or whose e-way bill expires today, packed first (at most 5,000 scanned, truncated); exceptions — device handovers that left without them, until a late record clears them',
  })
  @ApiOkResponse({ type: ConsignmentWorklistResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId or view (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async worklist(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Query() query: ConsignmentWorklistQueryDto,
    @CurrentSession() session: TenantSession,
  ): Promise<ConsignmentWorklistResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    if (query.clientId !== undefined) assertUuid(query.clientId, 'clientId');
    const page = await this.outbound.consignmentWorklist(tenantId, warehouseId, {
      clientId: query.clientId === undefined ? null : query.clientId.toLowerCase(),
      view: query.view ?? 'needed',
    });
    return JSON.parse(JSON.stringify(page)) as ConsignmentWorklistResponse;
  }
}

function assertOwnTenant(sessionTenantId: string, tenantId: string): void {
  if (sessionTenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `${name} must be a uuid`, `The "${name}" ${name === 'clientId' ? 'query' : 'path'} parameter must be a uuid (got "${value}").`);
  }
}
