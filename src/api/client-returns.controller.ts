import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ReturnsFacade, type ClientReturnView } from '../modules/returns/returns.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelClientReturnDto,
  ClientReturnDto,
  ClientReturnListQueryDto,
  ClientReturnListResponse,
  CreateClientReturnDto,
  DispatchClientReturnDto,
  PickClientReturnDto,
  ReturnableToClientQuery,
  ReturnableToClientResponse,
} from './client-returns.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)';
const MANAGE_403 = 'Session belongs to another tenant (permission-denied), the caller lacks returns.manage (role-denied), or a client-portal session (role-denied — operators only)';

/**
 * Story 4-7c — the return-to-client surface: returned (RETURNS) and damaged
 * (DAMAGED) units shipped back to the brand. Create and cancel on the web
 * (`returns.manage`), the scan-verified pick on the handheld (`rtc.pick`,
 * the badge-in session, `picks.execute`), the dispatch on the web
 * (`dispatch.execute`) — the one moment stock leaves (`rtc.dispatched`).
 * Member-open reads: the list, one RTC, and one client's returnable units
 * in a warehouse. Everything goes through `ReturnsFacade`.
 *
 * No route-order hazard: the only literal sibling (`returnable`) lives under
 * `warehouses/{w}/…`, a different prefix from `client-returns/:id`.
 */
@ApiTags('client-returns')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientReturnsController {
  constructor(@Inject(ReturnsFacade) private readonly returns: ReturnsFacade) {}

  @Post(':tenantId/client-returns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Creates a return to client (returns.manage) — one client's returned units awaiting disposition (RETURNS) and damaged units (DAMAGED) in one warehouse going back to the brand: the brand and its chosen address frozen. A returns line claims its receipt line's open quantity; a damaged line claims the DAMAGED pool (no stock moves until dispatch)",
  })
  @ApiBody({ type: CreateClientReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientReturnDto, description: 'The return to client, draft (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — no lines or over 200, a repeated receipt line or (SKU, batch), a returns line without its receipt line or with a SKU, a damaged line without a SKU, a quantity not above 0 or finer than its unit, a serial line not 1, an unknown reason, "other" without a note, a note over 500, a batch-tracked damaged line without its batch or a batch on an untracked one (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, a receipt line, a SKU, a batch or the client does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "A blind return still awaiting review or rejected (review-pending, review-rejected); a receipt line of another warehouse (document-warehouse-mismatch); a catch-weight, kit, returned-case or (from DAMAGED) serial-tracked SKU — member skuCode (rtc-sku-unsupported); SKUs of two clients (mixed-client); the client has no address of the chosen kind — members addressKind, clientId (client-address-missing); more than awaits disposition — member awaitingQty (exceeds-awaiting); more than DAMAGED holds after the open RTV and RTC claims — members onHandQty, claimedQty, availableQty, requestedQty (rtc-exceeds-damaged); or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async create(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateClientReturnDto,
  ): Promise<ClientReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.returns.createClientReturn(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        consigneeAddress: dto.consigneeAddress ?? null,
        note: dto.note ?? null,
        // BASE units cross this edge; the command scales them behind its replay lookup.
        lines: dto.lines.map((line) => ({
          source: line.source,
          returnReceiptLineId: line.returnReceiptLineId ?? null,
          skuId: line.skuId ?? null,
          batchId: line.batchId ?? null,
          quantity: line.quantity,
          reasonCode: line.reasonCode ?? null,
        })),
      },
      key,
    );
    return toDto(view);
  }

  @Get(':tenantId/client-returns')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists returns to client, newest first (keyset cursor), filterable by warehouse, client and status — open to any member' })
  @ApiOkResponse({ type: ClientReturnListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter or limit (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ClientReturnListQueryDto,
  ): Promise<ClientReturnListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.returns.listClientReturns(tenantId, {
      warehouseId: query.warehouseId,
      clientId: query.clientId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/client-returns/:clientReturnId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One return to client — its frozen brand and address, lines, pick, dispatch capture and cancellation (the printable note reads it) — open to any member' })
  @ApiOkResponse({ type: ClientReturnDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed id (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to client in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientReturnId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('clientReturnId') clientReturnId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(clientReturnId);
    return toDto(await this.returns.getClientReturn(tenantId, clientReturnId));
  }

  /** `rtc.pick` — the handheld op (badge-in session; the `Idempotency-Key` is the op's ULID). */
  @Post(':tenantId/client-returns/:clientReturnId/pick')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "rtc.pick — records the handheld's scan-verified pick of a draft return to client exactly once (badge-in session, picks.execute): every line with its picked quantity (a short pick is allowed and returns the rest of a returns line to awaiting disposition; an empty one is refused). Moves no stock — the dispatch does",
  })
  @ApiBody({ type: PickClientReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ClientReturnDto, description: 'The return to client, picked (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — a malformed id, no lines or a repeated line, a negative or too-fine quantity, a non-UTC occurredAt (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator is not a floor role or lacks picks.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such return to client in this tenant, or it is another warehouse's (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('The return to client is not a draft — picked, dispatched or cancelled — member rtcStatus (rtc-not-draft); or a concurrent idempotent request (conflict)') })
  @ApiResponse({
    status: 422,
    ...problemJsonResponse(
      "The lines are not exactly the return's, a line is picked above its quantity, or a serial line other than 0 or 1 (rtc-pick-mismatch); every line picked 0 (rtc-pick-empty); or the Idempotency-Key reused with a different payload (idempotency-key-reuse)",
    ),
  })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  @ApiParam({ name: 'clientReturnId', format: 'uuid' })
  async pick(
    @Param('tenantId') tenantId: string,
    @Param('clientReturnId') clientReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: PickClientReturnDto,
  ): Promise<ClientReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    assertUuidParam(clientReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.returns.pickClientReturn(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        clientReturnId,
        warehouseId: dto.warehouseId,
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line) => ({ lineId: line.lineId, pickedQty: line.pickedQty })),
      },
      key,
    );
    return toDto(view);
  }

  @Post(':tenantId/client-returns/:clientReturnId/dispatch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Dispatches a picked return to client (dispatch.execute): records the brand's challan or invoice, the GSTINs, the declared value, the e-way bill, the carrier and the packages, freezes the transporter and the warehouse, and writes one rtc.dispatched draw out of RETURNS or DAMAGED per picked line (per serial unit) — the units leave stock",
  })
  @ApiBody({ type: DispatchClientReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ClientReturnDto, description: 'The return to client, dispatched (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid capture — no brand document, an unknown document type, a number over 40, a malformed date or one after today or more than 30 days before the return was created, a malformed or wrong-state consignor or consignee GSTIN, a declared value that is not a whole number of paise 0–10¹², an e-way bill number that is not 12 digits or has no date, a validity before the date, none of transporter / carrier name / vehicle, a malformed vehicle, a tracking ref over 50, a package count outside 1–9999, or a debit note (an RTV field) (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks dispatch.execute (role-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to client, or no such transporter, in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The return to client is not picked — member rtcStatus (rtc-not-picked); the partner is not a transporter or is inactive (partner-not-transporter, transporter-inactive); a reconcile quarantine on RETURNS or DAMAGED (disposition-scope-quarantined); DAMAGED no longer holds the picked units — members onHandQty, pickedQty (rtc-damaged-short); a user location occupies the RETURNS or DAMAGED code (returns-bin-conflict, damaged-bin-conflict); or a concurrent idempotent request (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientReturnId', format: 'uuid' })
  async dispatch(
    @Param('tenantId') tenantId: string,
    @Param('clientReturnId') clientReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: DispatchClientReturnDto,
  ): Promise<ClientReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(clientReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.returns.dispatchClientReturn(
      {
        tenantId,
        actorUserId: session.userId,
        clientReturnId,
        brandDocument: dto.brandDocument === undefined ? null : { type: dto.brandDocument.type, number: dto.brandDocument.number, date: dto.brandDocument.date },
        consignorGstin: dto.consignorGstin ?? null,
        consigneeGstin: dto.consigneeGstin ?? null,
        declaredValuePaise: dto.declaredValuePaise ?? null,
        ewayBillNumber: dto.ewayBillNumber ?? null,
        ewayBillDate: dto.ewayBillDate ?? null,
        ewayValidUntil: dto.ewayValidUntil ?? null,
        transporterId: dto.transporterId ?? null,
        carrierName: dto.carrierName ?? null,
        vehicleNumber: dto.vehicleNumber ?? null,
        trackingRef: dto.trackingRef ?? null,
        packageCount: dto.packageCount ?? null,
      },
      key,
    );
    return toDto(view);
  }

  @Post(':tenantId/client-returns/:clientReturnId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels a draft or picked return to client with a reason (returns.manage) — its claims are released: a returns line goes back to awaiting disposition, a damaged line frees the DAMAGED pool; nothing moved, so nothing moves back',
  })
  @ApiBody({ type: CancelClientReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ClientReturnDto, description: 'The return to client, cancelled (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a blank reason or one over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to client in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The return to client is dispatched or already cancelled — member rtcStatus (rtc-closed); or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientReturnId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('clientReturnId') clientReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CancelClientReturnDto,
  ): Promise<ClientReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(clientReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return toDto(await this.returns.cancelClientReturn({ tenantId, actorUserId: session.userId, clientReturnId, reason: dto.reason }, key));
  }

  @Get(':tenantId/warehouses/:warehouseId/client-returns/returnable')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One client's units in a warehouse that can go back to it: the receipt lines awaiting disposition (4-7a's queue) and the DAMAGED arms with on-hand, the open RTV and RTC claims and what is available — open to any member",
  })
  @ApiOkResponse({ type: ReturnableToClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId or clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async returnable(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ReturnableToClientQuery,
  ): Promise<ReturnableToClientResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId);
    const read = await this.returns.returnableToClient(tenantId, warehouseId, query.clientId);
    return {
      warehouseId: read.warehouseId,
      clientId: read.clientId,
      truncated: read.truncated,
      awaiting: read.awaiting.map((row) => ({ ...row })),
      damaged: read.damaged.map((arm) => ({ ...arm, claimedBy: [...arm.claimedBy] })),
    };
  }
}

/** The view as the DTO — copied key by key where the DTO has mutable arrays. */
function toDto(view: ClientReturnView): ClientReturnDto {
  return {
    ...view,
    warehouse: { ...view.warehouse },
    consigneeAddress: { ...view.consigneeAddress },
    lines: view.lines.map((line) => ({ ...line })),
  } as ClientReturnDto;
}

function assertOwnTenantToken(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

/** Uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, 'Invalid id', `"${value}" is not a uuid.`);
  }
}
