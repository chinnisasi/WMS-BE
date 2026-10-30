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
import { ReturnsFacade } from '../modules/returns/returns.facade';
import type { BlindAcceptResult, BlindReceiptResult, ReturnableOrder, ReturnDispositionResult, ReturnReceiptResult, RmaDetail } from '../modules/returns/returns.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AcceptBlindReturnDto,
  BlindAcceptResultDto,
  BlindReceiptResultDto,
  ReceiveBlindReturnDto,
  RejectBlindReturnDto,
  AwaitingDispositionListResponse,
  AwaitingDispositionQuery,
  CancelReturnAuthorizationDto,
  CreateReturnAuthorizationDto,
  DisposeReturnDto,
  ReceiveReturnDto,
  RestockReturnDto,
  ReturnDispositionResultDto,
  ReturnReceiptResultDto,
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
 *
 * Story 13-2 adds `POST returns/receipts` — `return.receive`, the handheld op
 * under `DeviceSessionGuard` (the badge-in session; `grn.submit`'s shape) —
 * and the detail read's receipts.
 *
 * Story 4-7a adds the disposition surface: `POST returns/dispositions` (the
 * web — restock, quarantine or scrap one receipt line; `returns.manage`),
 * `POST returns/restocks` (the handheld's `return.restock`, a badge-in floor
 * role) and `GET returns/awaiting` (the queue, oldest first) — the literal
 * `awaiting` declared before `:rmaId`, like `returnable`.
 *
 * Story 4-7b adds blind returns: `POST returns/blind-receipts` (the
 * handheld's `return.receive_blind` — an unannounced parcel; declared before
 * every `:rmaId` route), and the web review `POST returns/:rmaId/accept` and
 * `POST returns/:rmaId/reject` (`returns.manage`).
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

  /**
   * Story 4-7b — `return.receive_blind`, the handheld's unannounced parcel
   * (badge-in device session; the key is the op's ULID). The literal
   * `blind-receipts` is declared BEFORE every `:rmaId` route (guide §6).
   */
  @Post(':tenantId/returns/blind-receipts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "return.receive_blind — receives an unannounced parcel (no RMA) exactly once (badge-in session required): each entry of the parcel's client that resolves books a return.received into RETURNS under an auto-created blind return authorization (born received, review pending — nothing can be dispositioned or reach ATP until it is accepted on the web); every other entry is refused into ONE review-queue row (Discard only). The parcel reference suggests one dispatched order (carrier AWB, then the order reference)",
  })
  @ApiBody({ type: ReceiveBlindReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: BlindReceiptResultDto,
    description: 'Recorded: the blind RMA and its receipt (null when every entry was refused), the suggested order, and per entry applied or refused with its reason (the idempotency snapshot)',
  })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — no entries or over 150, a malformed id, a non-boolean clientPrompted, a parcel reference over 64 characters, a non-positive qty, an unknown condition, a note over 200 characters, a serial or weight entry whose qty is not 1, both a serial and a weight, or a non-UTC occurredAt (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator is not a floor role (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse('A user zone or bin named RETURNS blocks the system returns bin (returns-bin-conflict), or a concurrent idempotent request (conflict)'),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async receiveBlind(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: ReceiveBlindReturnDto,
  ): Promise<BlindReceiptResultDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.returns.receiveBlind(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        clientId: dto.clientId,
        clientPrompted: dto.clientPrompted,
        parcelReference: dto.parcelReference ?? null,
        occurredAt: dto.occurredAt,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup. Optional keys normalise in the command.
        entries: dto.entries.map((entry) => ({
          skuId: entry.skuId,
          qty: entry.qty,
          condition: entry.condition,
          note: entry.note ?? null,
          batchCode: entry.batchCode ?? null,
          serialNumber: entry.serialNumber ?? null,
          weightGrams: entry.weightGrams ?? null,
        })),
      },
      key,
    );
    return toBlindReceiptDto(result);
  }

  /**
   * Story 13-2 — `return.receive`, the handheld op (badge-in device session;
   * the `Idempotency-Key` is the op's ULID). A literal segment beside
   * `POST returns/:rmaId/cancel` — different depth, so no route-order hazard.
   */
  @Post(':tenantId/returns/receipts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'return.receive — receives returned units against a return authorization exactly once (badge-in session required): each entry that matches its line books a return.received ledger event into the warehouse\'s system RETURNS bin (awaiting disposition — outside ATP) with its condition grade; every other entry is refused and lands in ONE review-queue row (Discard only)',
  })
  @ApiBody({ type: ReceiveReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: ReturnReceiptResultDto,
    description:
      'Recorded: the receipt (null when every entry was refused), the authorization\'s new status, and per entry applied or refused with its reason (the idempotency snapshot)',
  })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — no entries or over 150, a malformed id, a non-positive qty, an unknown condition, a note over 200 characters, a serial or weight entry whose qty is not 1, both a serial and a weight, a non-UTC occurredAt, or a quantity finer than its unit (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator is not a floor role (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The return authorization does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The authorization belongs to another warehouse (document-warehouse-mismatch — checked before its status), it is not open or partially received (rma-not-receivable), a user zone or bin named RETURNS blocks the system returns bin (returns-bin-conflict), or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async receive(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: ReceiveReturnDto,
  ): Promise<ReturnReceiptResultDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.returns.receive(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        rmaId: dto.rmaId,
        occurredAt: dto.occurredAt,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup (story 10.2). Optional keys pass through — the
        // command normalises them (`?? null`) before hashing.
        entries: dto.entries.map((entry) => ({
          rmaLineId: entry.rmaLineId ?? null,
          skuId: entry.skuId,
          qty: entry.qty,
          condition: entry.condition,
          note: entry.note ?? null,
          batchCode: entry.batchCode ?? null,
          serialNumber: entry.serialNumber ?? null,
          weightGrams: entry.weightGrams ?? null,
        })),
      },
      key,
    );
    return toReceiptDto(result);
  }

  /**
   * Story 4-7a — the web's disposition of one receipt line (or part of it):
   * restock into a storage bin, quarantine on a QC hold, or scrap.
   */
  @Post(':tenantId/returns/dispositions')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Dispositions a received return unit (returns.manage): restock — return.restocked RETURNS → a storage bin through every placement gate (ATP rises); quarantine — a QC hold of kind return (RETURNS → QC-HOLD; a release brings the units back); scrap — return.scrapped out of RETURNS with a reason (above the tenant write-off threshold refused). At most what the line still awaits',
  })
  @ApiBody({ type: DisposeReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ReturnDispositionResultDto, description: 'The disposition (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — an unknown outcome, a non-positive qty, a restock without toBinId or with a reason/note, a quarantine or scrap without a reason or with a bin, "other" without a note, a note over 200 characters, a quantity finer than its unit, a serial unit or returned case not disposed whole, or a system bin as the target (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(`${WRITE_403}; or a secure target bin without secure.move (role-denied)`) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, the receipt line or the target bin does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The line is another warehouse's (document-warehouse-mismatch); quarantine of a serial-tracked or catch-weight unit (disposition-not-supported); an expired or blocked batch on a restock (batch-expired / batch-blocked); more than the line awaits — member awaitingQty (exceeds-awaiting); a scrap above the tenant's write-off threshold — members awaitingQty, threshold (scrap-above-threshold); a reconcile quarantine on RETURNS or the target (disposition-scope-quarantined); a placement-gate refusal with the gate's own code (bin-retired, bin-blocked, bin-storage-mismatch, bin-client-mismatch, bin-occupancy-conflict, bin-segregation-conflict, bin-full, bin-overweight, bin-volume-exceeded, bin-item-oversize); or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async dispose(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: DisposeReturnDto,
  ): Promise<ReturnDispositionResultDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // BASE units cross this edge; the command scales them behind its replay
    // lookup (story 10.2).
    const result = await this.returns.dispose(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        receiptLineId: dto.receiptLineId,
        outcome: dto.outcome,
        qty: dto.qty,
        toBinId: dto.toBinId ?? null,
        reasonCode: dto.reasonCode ?? null,
        note: dto.note ?? null,
      },
      key,
    );
    return toDispositionDto(result);
  }

  /**
   * Story 4-7a — `return.restock`, the handheld op (badge-in device session;
   * the `Idempotency-Key` is the op's ULID): a SKU (batch, or serials)
   * restocked into a scanned storage bin, allocated oldest-first.
   */
  @Post(':tenantId/returns/restocks')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "return.restock — restocks returned units into a storage bin exactly once (badge-in session required): the server allocates the SKU (and batch, or the named serials) to the warehouse's oldest sellable (resaleable) awaiting receipt lines and writes one return.restocked per line through every placement gate",
  })
  @ApiBody({ type: RestockReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ReturnDispositionResultDto, description: 'The dispositions, one per receipt line drawn (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — a malformed id, a non-positive qty, a non-UTC occurredAt, repeated or uncounted serials, serials with a batchCode, serials on a SKU that is not serial-tracked (or none on one that is), a batch on an unbatched SKU, a catch-weight SKU (restocked on the web), a quantity finer than its unit, or a system bin as the target (validation-failed); a batch-tracked SKU without its batch (batch-required)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), the operator is not a floor role, or a secure target bin without secure.move (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, the SKU or the target bin does not exist (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "Less is awaiting than the restock names — member awaitingQty (exceeds-awaiting); a named serial is not awaiting (or was graded non-sellable) — member serialNumber (serial-not-awaiting); an expired or blocked batch (batch-expired / batch-blocked); a reconcile quarantine (disposition-scope-quarantined); a placement-gate refusal with the gate's own code; or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async restock(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: RestockReturnDto,
  ): Promise<ReturnDispositionResultDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.returns.restock(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        qty: dto.qty,
        batchCode: dto.batchCode ?? null,
        serialNumbers: dto.serialNumbers ?? null,
        toBinId: dto.toBinId,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return toDispositionDto(result);
  }

  // Declared BEFORE `:rmaId` — see the class comment.
  @Get(':tenantId/returns/awaiting')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 4-7a — the awaiting-disposition queue: every received return line with units still awaiting a disposition, OLDEST first (keyset on the line's createdAt, id), optionally one warehouse's and one client's — with the grade, the capture, the open and on-hold quantities and the line's quarantine history",
  })
  @ApiOkResponse({ type: AwaitingDispositionListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId or clientId, a limit outside 1–100 (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async awaiting(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: AwaitingDispositionQuery,
  ): Promise<AwaitingDispositionListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.returns.listAwaiting(tenantId, {
      warehouseId: query.warehouseId,
      clientId: query.clientId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
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
      clientId: query.clientId,
      origin: query.origin,
      reviewStatus: query.reviewStatus,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toRmaDto), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/returns/:rmaId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One return authorization with its lines, reasons and serials — and (story 13-2) its receipts: each received line\'s condition, note, batch, serial and case weight, and the receiving operator\'s email' })
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

  /** Story 4-7b — accept an unannounced return at review (returns.manage). */
  @Post(':tenantId/returns/:rmaId/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Accepts an unannounced return at review (returns.manage): optionally links a dispatched order of the parcel's client and warehouse — each line links to an order line it fits (its SKU, enough returnable, its serials dispatched there) and then counts against that order's returnable; a line that fits nowhere stays unlinked and is named, never refused — and opens its units to disposition",
  })
  @ApiBody({ type: AcceptBlindReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: BlindAcceptResultDto, description: 'The accepted return and its unlinked lines (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed rmaId or orderId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The return authorization or the order does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The return was authorized, not received unannounced — member origin (rma-not-blind); its review is already decided — member reviewStatus (review-not-pending); the order is another client's (order-client-mismatch), another warehouse's (document-warehouse-mismatch) or not dispatched — member orderStatus (order-not-dispatched); or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rmaId', format: 'uuid' })
  async acceptBlind(
    @Param('tenantId') tenantId: string,
    @Param('rmaId') rmaId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AcceptBlindReturnDto,
  ): Promise<BlindAcceptResultDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(rmaId, 'rmaId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.returns.acceptBlind({ tenantId, actorUserId: session.userId, rmaId, orderId: dto.orderId ?? null }, key);
    return toBlindAcceptDto(result);
  }

  /** Story 4-7b — reject an unannounced return at review, reversing its booking (returns.manage). */
  @Post(':tenantId/returns/:rmaId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rejects an unannounced return at review (returns.manage) with a reason: each received line is reversed out of RETURNS (return.reversed), a returned case is rejected, and the units can be received again correctly. Only while the review is pending; refused above the tenant write-off threshold',
  })
  @ApiBody({ type: RejectBlindReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ReturnAuthorizationDto, description: 'The rejected return (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown reasonCode, "other" without a note, or a note over 200 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The return authorization does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The return was authorized, not received unannounced — member origin (rma-not-blind); its review is already decided — member reviewStatus (review-not-pending); its units exceed the tenant's write-off threshold — members threshold, totalQty (reject-above-threshold); RETURNS is under a reconcile quarantine (disposition-scope-quarantined); or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rmaId', format: 'uuid' })
  async rejectBlind(
    @Param('tenantId') tenantId: string,
    @Param('rmaId') rmaId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RejectBlindReturnDto,
  ): Promise<ReturnAuthorizationDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(rmaId, 'rmaId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const rma = await this.returns.rejectBlind({ tenantId, actorUserId: session.userId, rmaId, reasonCode: dto.reasonCode, note: dto.note ?? null }, key);
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
  const { receipts, ...rest } = rma;
  return {
    ...rest,
    lines: rma.lines.map((line) => ({ ...line, serials: line.serials.map((serial) => ({ ...serial })) })),
    // Story 13-2 — only the detail read carries receipts.
    ...(receipts === undefined
      ? {}
      : { receipts: receipts.map((receipt) => ({ ...receipt, lines: receipt.lines.map((line) => ({ ...line })) })) }),
  };
}

function toBlindReceiptDto(result: BlindReceiptResult): BlindReceiptResultDto {
  return {
    ...result,
    applied: result.applied.map((item) => ({ ...item })),
    refused: result.refused.map((item) => ({ ...item })),
  };
}

function toBlindAcceptDto(result: BlindAcceptResult): BlindAcceptResultDto {
  return { ...toRmaDto(result), unlinkedLines: [...result.unlinkedLines] };
}

function toDispositionDto(result: ReturnDispositionResult): ReturnDispositionResultDto {
  return { dispositions: result.dispositions.map((entry) => ({ ...entry })) };
}

function toReceiptDto(result: ReturnReceiptResult): ReturnReceiptResultDto {
  return {
    ...result,
    applied: result.applied.map((item) => ({ ...item })),
    refused: result.refused.map((item) => ({ ...item })),
  };
}

function toReturnableDto(read: ReturnableOrder): ReturnableOrderDto {
  return {
    ...read,
    lines: read.lines.map((line) => ({ ...line, returnableSerials: line.returnableSerials.map((serial) => ({ ...serial })) })),
  };
}
