import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ReturnsFacade } from '../modules/returns/returns.facade';
import type { ReturnableOrder, RmaDetail } from '../modules/returns/returns.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelReturnAuthorizationDto,
  CreateReturnAuthorizationDto,
  ReturnableOrderDto,
  ReturnableQuery,
  ReturnAuthorizationDto,
  ReturnAuthorizationListQuery,
  ReturnAuthorizationListResponse,
} from '../modules/returns/returns.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const WRITE_403 =
  'Session belongs to another tenant (permission-denied), the caller lacks returns.manage (role-denied), or a client-portal session (role-denied — operators only)';
const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)';

/**
 * The returns HTTP surface (story 13-1, FR-46): authorize part of a
 * dispatched order for return (an RMA) and cancel one — both
 * `returns.manage`, owner + ops manager — and three member-open reads: one
 * order's returnable quantities, the list, and one authorization. Every route
 * carries `TenantSessionGuard` (whose fence refuses a client-portal token —
 * 13-1 opens no portal access). Everything goes through `ReturnsFacade`.
 *
 * ROUTE ORDER IS LOAD-BEARING (IMPLEMENTATION-GUIDE §6): the literal
 * `GET returns/returnable` is declared BEFORE `GET returns/:rmaId`, or Express
 * would hand `returnable` to the param route as an rmaId and answer 400.
 * Pinned by `test/returns.spec.ts` (behaviour and method order).
 */
@ApiTags('returns')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ReturnsController {
  constructor(@Inject(ReturnsFacade) private readonly returns: ReturnsFacade) {}

  @Post(':tenantId/returns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Authorizes part of a dispatched order for return — an RMA (returns.manage): per order line a quantity, the serial numbers of a serial-tracked SKU, and a reason; bounded by what was dispatched minus what open authorizations already name. Moves no stock",
  })
  @ApiBody({ type: CreateReturnAuthorizationDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ReturnAuthorizationDto, description: 'The authorization, open (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — no lines or over 200, a repeated orderLineId, qty not above 0, an unknown reasonCode, "other" without a note, blank/repeated serial numbers, a serial count unequal to qty, over 500 serials, serials on a SKU that is not serial-tracked or none on one that is, or a quantity finer than its unit (validation-failed); a line not on the order (line-not-of-order); a kit parent line (kit-parent-not-returnable)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The order does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The order is not dispatched (order-not-dispatched), a quantity above what is still returnable — members orderLineId and returnableQty (exceeds-returnable), a serial not dispatched on the line (serial-not-dispatched) or already on an open authorization (serial-already-authorized) — members orderLineId and serialNumber — or a concurrent idempotent request (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async create(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateReturnAuthorizationDto,
  ): Promise<ReturnAuthorizationDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const rma = await this.returns.create(
      {
        tenantId,
        actorUserId: session.userId,
        orderId: dto.orderId,
        externalReference: dto.externalReference ?? null,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup (story 10.2).
        lines: dto.lines.map((line) => ({
          orderLineId: line.orderLineId,
          qty: line.qty,
          reasonCode: line.reasonCode,
          reasonNote: line.reasonNote ?? null,
          serialNumbers: line.serialNumbers ?? null,
        })),
      },
      key,
    );
    return toRmaDto(rma);
  }

  // Declared BEFORE `:rmaId` — see the class comment.
  @Get(':tenantId/returns/returnable')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One order's returnable quantities per line — dispatched, already authorized on open returns, still returnable — and a serial-tracked line's returnable serials. An order that is not dispatched answers its status with zero everywhere",
  })
  @ApiOkResponse({ type: ReturnableOrderDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('A missing or malformed orderId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The order does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async returnable(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ReturnableQuery,
  ): Promise<ReturnableOrderDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return toReturnableDto(await this.returns.returnable(tenantId, query.orderId));
  }

  @Get(':tenantId/returns')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Lists return authorizations newest first (keyset on createdAt, id), optionally one warehouse’s (tenant-wide without it), one status’s, one order’s — each with its lines',
  })
  @ApiOkResponse({ type: ReturnAuthorizationListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId, status or orderId, a limit outside 1–100 (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ReturnAuthorizationListQuery,
  ): Promise<ReturnAuthorizationListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.returns.list(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      orderId: query.orderId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toRmaDto), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/returns/:rmaId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One return authorization with its lines, reasons and serials' })
  @ApiOkResponse({ type: ReturnAuthorizationDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed rmaId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No return authorization with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rmaId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('rmaId') rmaId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ReturnAuthorizationDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(rmaId, 'rmaId');
    const rma = await this.returns.get(tenantId, rmaId);
    if (rma === null) {
      throw new ProblemException(
        'not-found',
        404,
        'Return authorization not found',
        `No return authorization with id "${rmaId}" exists in this tenant.`,
      );
    }
    return toRmaDto(rma);
  }

  @Post(':tenantId/returns/:rmaId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels an open return authorization nothing was received against (returns.manage), with a reason — its quantity and serials become returnable again',
  })
  @ApiBody({ type: CancelReturnAuthorizationDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ReturnAuthorizationDto, description: 'The cancelled authorization (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed rmaId, or a reason that is blank or over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No return authorization with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The authorization is not open, or units were received against it (rma-transition-invalid), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rmaId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('rmaId') rmaId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CancelReturnAuthorizationDto,
  ): Promise<ReturnAuthorizationDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(rmaId, 'rmaId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const rma = await this.returns.cancel({ tenantId, actorUserId: session.userId, rmaId, reason: dto.reason }, key);
    return toRmaDto(rma);
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

/** Uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'rmaId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `${name} must be a uuid`, `The "${name}" path parameter must be a uuid (got "${value}").`);
  }
}

/** A fresh object per response (the shell never hands out the snapshot itself). */
function toRmaDto(rma: RmaDetail): ReturnAuthorizationDto {
  return {
    ...rma,
    lines: rma.lines.map((line) => ({ ...line, serials: line.serials.map((serial) => ({ ...serial })) })),
  };
}

function toReturnableDto(read: ReturnableOrder): ReturnableOrderDto {
  return {
    ...read,
    lines: read.lines.map((line) => ({ ...line, returnableSerials: line.returnableSerials.map((serial) => ({ ...serial })) })),
  };
}
