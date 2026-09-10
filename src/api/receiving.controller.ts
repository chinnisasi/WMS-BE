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
import { ReceivingFacade } from '../modules/inbound/receiving.facade';
import { QcFacade } from '../modules/inbound/qc.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CatalogSnapshotQuery,
  CatalogSnapshotResponse,
  GoodsReceiptListQuery,
  GoodsReceiptListResponse,
  GoodsReceiptResponse,
  OverReceiptDecisionResponse,
  OverReceiptListQuery,
  OverReceiptListResponse,
  SubmitGoodsReceiptDto,
} from '../modules/inbound/receiving.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  PlaceQcHoldDto,
  QcHoldListQuery,
  QcHoldListResponse,
  QcHoldResponse,
} from '../modules/inbound/qc.dto';
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
 * The receiving HTTP surface (Story 3.3): the device-side `grn.submit` route
 * (badge-in session — the substrate's first real op) and the web-side read +
 * decision surfaces (GRN list, over-receipt queue, approve/reject gated by
 * `review.decide`). The api shell is the only HTTP surface of the monolith;
 * every mutation goes through `ReceivingFacade`, whose commands re-evaluate
 * device status / operator role / caller role against the DB at entry — the
 * token is transport, never authority.
 */
@ApiTags('receiving')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ReceivingController {
  constructor(
    @Inject(ReceivingFacade) private readonly receiving: ReceivingFacade,
    @Inject(QcFacade) private readonly qc: QcFacade,
  ) {}

  @Post(':tenantId/receiving/goods-receipts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'grn.submit — records a whole goods receipt exactly once (badge-in session required); the excess over a line\'s open quantity pends for Ops Manager approval',
  })
  @ApiBody({ type: SubmitGoodsReceiptDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: GoodsReceiptResponse,
    description:
      'GRN recorded: server-assigned code, per-line physical/applied/excess quantities, ledger events for the applied portion (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator was demoted to accountant (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, purchase order, or a line\'s SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The PO is not open (po-not-open, naming the status), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async submitGoodsReceipt(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: SubmitGoodsReceiptDto,
  ): Promise<GoodsReceiptResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.submitGoodsReceipt(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        poId: dto.poId ?? null,
        blindReasonCode: dto.blindReasonCode ?? null,
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line) => ({
          poLineId: line.poLineId ?? null,
          skuId: line.skuId,
          batchCode: line.batchCode ?? null,
          mfgDate: line.mfgDate ?? null,
          qty: line.qty,
        })),
      },
      key,
    );
    return { goodsReceipt: { ...snapshot.goodsReceipt } };
  }

  @Get(':tenantId/devices/catalog-snapshot')
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The device catalog snapshot (badge-in session required): SKU barcode map + open PO lines for the offline decision mirror (AD-4)',
  })
  @ApiOkResponse({
    type: CatalogSnapshotResponse,
    description: 'The warehouse\'s SKU scan identity + open purchase orders with per-line quantities',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async getCatalogSnapshot(
    @Param('tenantId') tenantId: string,
    @CurrentDeviceSession() session: DeviceSession,
    @Query() query: CatalogSnapshotQuery,
  ): Promise<CatalogSnapshotResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw badgeInRequired();
    }
    assertUuidParam(query.warehouseId, 'warehouseId');
    return this.receiving.getCatalogSnapshot(tenantId, query.warehouseId);
  }

  @Get(':tenantId/receiving/goods-receipts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists goods receipt notes (keyset cursor pagination, warehouse-filterable — open to any member)",
  })
  @ApiOkResponse({
    type: GoodsReceiptListResponse,
    description: 'The GRN page (headers with line/unit sums — the Inbound surface\'s list read)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), malformed warehouseId, or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listGoodsReceipts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: GoodsReceiptListQuery,
  ): Promise<GoodsReceiptListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    const page = await this.receiving.listGoodsReceipts(tenantId, {
      warehouseId: query.warehouseId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/receiving/over-receipts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists over-receipts (keyset cursor pagination, status-filterable — the Conflicts & Reviews queue read)',
  })
  @ApiOkResponse({ type: OverReceiptListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listOverReceipts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OverReceiptListQuery,
  ): Promise<OverReceiptListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.receiving.listOverReceipts(tenantId, {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/receiving/over-receipts/:overReceiptId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Approves an over-receipt (review.decide) — a grn.received ledger event applies the excess and received_qty bumps; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: OverReceiptDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed overReceiptId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No over-receipt with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (over-receipt-decided), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'overReceiptId', format: 'uuid' })
  async approveOverReceipt(
    @Param('tenantId') tenantId: string,
    @Param('overReceiptId') overReceiptId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OverReceiptDecisionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(overReceiptId, 'overReceiptId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.decideOverReceipt(
      { tenantId, actorUserId: session.userId, overReceiptId, decision: 'approve' },
      key,
    );
    return { overReceipt: { ...snapshot.overReceipt } };
  }

  @Post(':tenantId/receiving/over-receipts/:overReceiptId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rejects an over-receipt (review.decide) — the excess stays unapplied; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: OverReceiptDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed overReceiptId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No over-receipt with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (over-receipt-decided), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'overReceiptId', format: 'uuid' })
  async rejectOverReceipt(
    @Param('tenantId') tenantId: string,
    @Param('overReceiptId') overReceiptId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OverReceiptDecisionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(overReceiptId, 'overReceiptId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.decideOverReceipt(
      { tenantId, actorUserId: session.userId, overReceiptId, decision: 'reject' },
      key,
    );
    return { overReceipt: { ...snapshot.overReceipt } };
  }

  @Post(':tenantId/receiving/qc-holds')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'qc-holds.place — quarantines a (sku, bin) scope: qc.held ledger movements move the stock into the warehouse\'s system QC-hold bin; ATP drops by the moved quantity (qc.manage)',
  })
  @ApiBody({ type: PlaceQcHoldDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: QcHoldResponse,
    description: 'Hold placed: the open hold row (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, or an empty scope (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, SKU, or bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('An open hold already covers this scope (qc-hold-open), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async placeQcHold(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PlaceQcHoldDto,
  ): Promise<QcHoldResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.placeHold(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        binId: dto.binId,
        reason: dto.reason,
      },
      key,
    );
    return { qcHold: { ...snapshot.qcHold } };
  }

  @Post(':tenantId/receiving/qc-holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Releases a QC hold (qc.manage) — qc.released movements return exactly the held units (the hold\'s own ledger arms) to its recorded origin bin; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: QcHoldResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed holdId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No QC hold with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already released (qc-hold-released), the origin bin no longer exists (qc-hold-origin-bin-gone), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'holdId', format: 'uuid' })
  async releaseQcHold(
    @Param('tenantId') tenantId: string,
    @Param('holdId') holdId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<QcHoldResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(holdId, 'holdId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.releaseHold(
      { tenantId, actorUserId: session.userId, holdId },
      key,
    );
    return { qcHold: { ...snapshot.qcHold } };
  }

  @Get(':tenantId/receiving/qc-holds')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists QC holds (keyset cursor pagination, warehouse- and status-filterable — open to any member)',
  })
  @ApiOkResponse({ type: QcHoldListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, warehouseId, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listQcHolds(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: QcHoldListQuery,
  ): Promise<QcHoldListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    const page = await this.qc.listQcHolds(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }
}

/** Receiving uuid path/query params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'overReceiptId' | 'holdId' | 'warehouseId'): void {
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