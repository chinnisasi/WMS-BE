import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { ClientChargeService, type ClientChargeView } from '../modules/billing/client-charge.service';
import {
  ChargeNoteDto,
  ChargePolicyDto,
  ChargePolicyResponse,
  ClientChargeListResponse,
  ClientChargeResponse,
  RecordClientChargeDto,
  RecordClientChargeResponse,
  type ClientChargeDto,
} from './client-charges.dto';
// Bound to @Query() — a value import (the ValidationPipe reads the class).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ClientChargeListQuery } from './client-charges.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session — a user with a client (role-denied): this is an operator surface';
const DECIDE_403 = 'Session belongs to another tenant (permission-denied), or the caller lacks billing.invoice — owner and accountant only (role-denied)';
const DECIDE_409 =
  'The charge is not pending (charge-not-pending), its billing month is already invoiced under its GSTIN (charge-period-invoiced), or a concurrent request with the same Idempotency-Key (conflict)';

/**
 * Story 5-5a — ad-hoc charges (contract billing). Reads are member-open
 * (portal sessions refused — a charge reaches the portal only as a frozen
 * invoice line); record and cancel need `billing.charge` (owner, ops
 * manager, accountant), approve / reject and the policy PUT `billing.invoice`
 * (owner, accountant). Holds no rules — the service owns authority, replay,
 * the locks and every guard; this maps DTOs.
 *
 * Route order: the literal `client-charges` (list, record) is declared
 * before `client-charges/:chargeId` (guide §6, route declaration order).
 */
@ApiTags('billing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientChargesController {
  constructor(@Inject(ClientChargeService) private readonly charges: ClientChargeService) {}

  @Post(':tenantId/client-charges')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Records an ad-hoc charge (billing.charge): one billable event for one client in one warehouse on one IST day, its figures fixed. Approved at record when the recorder holds billing.invoice and it is within the self-approval limit; otherwise pending. It bills on the first open month’s invoice of its GSTIN',
  })
  @ApiBody({ type: RecordClientChargeDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: RecordClientChargeResponse, description: 'The charge and any non-blocking warnings' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, a malformed clientId or warehouseId, a category, unit or SAC outside its vocabulary (an `other` charge without one of the four services SACs, or a SAC on any other category), a blank or over-long description / reference / clientAuthorizationRef / evidenceNote, a malformed or out-of-range quantity, a rate outside ₹0.01 .. ₹1 lakh, an amount that rounds to ₹0.00 or passes ₹1 crore, or a chargeDate in the future or before 1 April of the previous financial year (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks billing.charge — owner, ops manager and accountant (role-denied)'),
  })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such client, or no such warehouse, in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The tenant's own client (client-not-billable), a suspended or departed client (client-not-active), or a concurrent request with the same Idempotency-Key (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async record(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordClientChargeDto,
  ): Promise<RecordClientChargeResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.charges.record(
      {
        tenantId,
        actorUserId: session.userId,
        clientId: dto.clientId,
        warehouseId: dto.warehouseId,
        chargeDate: dto.chargeDate,
        category: dto.category,
        description: dto.description,
        sacCode: dto.sacCode,
        unit: dto.unit,
        quantity: dto.quantity,
        unitRatePaise: dto.unitRatePaise,
        reference: dto.reference,
        clientAuthorizationRef: dto.clientAuthorizationRef,
        evidenceNote: dto.evidenceNote,
      },
      key,
    );
    return { charge: toDto(result.charge), warnings: result.warnings.map((warning) => ({ ...warning })) };
  }

  @Get(':tenantId/client-charges')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The ad-hoc charges, newest first (keyset), filtered by client, warehouse, status and billing month; each with the invoice that bills it' })
  @ApiOkResponse({ type: ClientChargeListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId, warehouseId, status, month or limit (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(@Param('tenantId') tenantId: string, @CurrentSession() session: TenantSession, @Query() query: ClientChargeListQuery): Promise<ClientChargeListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.charges.list(tenantId, session.userId, {
      clientId: query.clientId,
      warehouseId: query.warehouseId,
      status: query.status,
      month: query.month,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/client-charges/:chargeId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One ad-hoc charge, with the invoice that bills it' })
  @ApiOkResponse({ type: ClientChargeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed chargeId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No ad-hoc charge with this id exists in this tenant (charge-not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'chargeId', format: 'uuid' })
  async get(@Param('tenantId') tenantId: string, @Param('chargeId') chargeId: string, @CurrentSession() session: TenantSession): Promise<ClientChargeResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(chargeId, 'chargeId');
    return { charge: toDto(await this.charges.get(tenantId, session.userId, chargeId)) };
  }

  @Post(':tenantId/client-charges/:chargeId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approves a pending ad-hoc charge (billing.invoice) — a second person: never the member who recorded it' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientChargeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed chargeId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(DECIDE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No ad-hoc charge with this id exists in this tenant (charge-not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`You recorded it (charge-needs-second-approver); ${DECIDE_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'chargeId', format: 'uuid' })
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('chargeId') chargeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientChargeResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(chargeId, 'chargeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return { charge: toDto((await this.charges.approve({ tenantId, actorUserId: session.userId, chargeId }, key)).charge) };
  }

  @Post(':tenantId/client-charges/:chargeId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rejects a pending ad-hoc charge with a note (billing.invoice) — it never bills' })
  @ApiBody({ type: ChargeNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientChargeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed chargeId, or a missing or over-long note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(DECIDE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No ad-hoc charge with this id exists in this tenant (charge-not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(DECIDE_409) })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'chargeId', format: 'uuid' })
  async reject(
    @Param('tenantId') tenantId: string,
    @Param('chargeId') chargeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ChargeNoteDto,
  ): Promise<ClientChargeResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(chargeId, 'chargeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return { charge: toDto((await this.charges.reject({ tenantId, actorUserId: session.userId, chargeId, note: dto.note }, key)).charge) };
  }

  @Post(':tenantId/client-charges/:chargeId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels an ad-hoc charge with a note (billing.charge): a pending charge by its recorder or a billing.invoice holder, an approved one by a billing.invoice holder — never once it is billed on an issued invoice',
  })
  @ApiBody({ type: ChargeNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientChargeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed chargeId, or a missing or over-long note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse(
      'Session belongs to another tenant, or another member’s pending charge / an approved charge without billing.invoice (permission-denied), or the caller lacks billing.charge (role-denied)',
    ),
  })
  @ApiResponse({ status: 404, ...problemJsonResponse('No ad-hoc charge with this id exists in this tenant (charge-not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The charge is rejected or already cancelled (charge-not-cancellable), it is billed on an issued, disputed or settled invoice or its billing month is invoiced (charge-period-invoiced), or a concurrent request with the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'chargeId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('chargeId') chargeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ChargeNoteDto,
  ): Promise<ClientChargeResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(chargeId, 'chargeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return { charge: toDto((await this.charges.cancel({ tenantId, actorUserId: session.userId, chargeId, note: dto.note }, key)).charge) };
  }

  @Get(':tenantId/client-charge-policy')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The ad-hoc charge self-approval limit (no setting = ₹10,000)' })
  @ApiOkResponse({ type: ChargePolicyResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getPolicy(@Param('tenantId') tenantId: string, @CurrentSession() session: TenantSession): Promise<ChargePolicyResponse> {
    assertOwnTenant(session, tenantId);
    return this.charges.getPolicy(tenantId, session.userId);
  }

  @Put(':tenantId/client-charge-policy')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sets the ad-hoc charge self-approval limit (billing.invoice — owner and accountant). Audited' })
  @ApiBody({ type: ChargePolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ChargePolicyResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a limit outside ₹0 .. ₹1 crore (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(DECIDE_403) })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async putPolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ChargePolicyDto,
  ): Promise<ChargePolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.charges.putPolicy({ tenantId, actorUserId: session.userId, selfApproveLimitPaise: dto.selfApproveLimitPaise }, key);
  }
}

function toDto(view: ClientChargeView): ClientChargeDto {
  return { ...view, billing: view.billing === null ? null : { ...view.billing } };
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

function assertUuidParam(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}
