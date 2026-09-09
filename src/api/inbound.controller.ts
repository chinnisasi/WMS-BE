import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { InboundFacade } from '../modules/inbound/inbound.facade';
import type { ListPurchaseOrdersQuery } from '../modules/inbound/inbound.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AmendPurchaseOrderDto,
  ClosePurchaseOrderDto,
  CreatePurchaseOrderDto,
  CreateVendorDto,
  PurchaseOrderCloseResponse,
  PurchaseOrderListQuery,
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
  VendorListQuery,
  VendorListResponse,
  VendorResponse,
} from '../modules/inbound/inbound.dto';

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
 * The inbound HTTP surface (Story 3.1): vendor master data (create + list)
 * and the PO lifecycle (create / amend / close / list / detail) — the api
 * shell is the only HTTP surface of the monolith, and every PO/vendor
 * mutation goes through `InboundFacade` (the command services re-evaluate
 * the role against the DB at entry). This story is pure upstream: no GRN /
 * receipt path, no ledger events, no FE consumption yet (the Inbound web
 * page is a later story; the FE re-runs `api:generate` after merge).
 */
@ApiTags('inbound')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class InboundController {
  constructor(@Inject(InboundFacade) private readonly inbound: InboundFacade) {}

  @Post(':tenantId/vendors')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a vendor (vendor.manage) — code unique per tenant' })
  @ApiBody({ type: CreateVendorDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: VendorResponse,
    description: 'Vendor created (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks vendor.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Vendor code already in use (conflict, naming the code), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createVendor(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateVendorDto,
  ): Promise<VendorResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.createVendor(
      {
        tenantId,
        actorUserId: session.userId,
        code: dto.code,
        name: dto.name,
        isDefault: dto.isDefault ?? false,
      },
      key,
    );
    return { vendor: { ...snapshot.vendor } };
  }

  @Get(':tenantId/vendors')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's vendors (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: VendorListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listVendors(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: VendorListQuery,
  ): Promise<VendorListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.listVendors(tenantId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/inbound/purchase-orders')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Creates a purchase order (po.manage) — warehouse-scoped, ≥1 line, code unique per tenant',
  })
  @ApiBody({ type: CreatePurchaseOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PurchaseOrderResponse,
    description: 'PO created open with per-line ordered / received (0) / open quantities (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or a non-positive qty / unit cost / malformed expectedDate (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks po.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, vendor, or a line\'s SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('PO code already in use (conflict, naming the code), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createPurchaseOrder(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.createPurchaseOrder(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        vendorId: dto.vendorId,
        code: dto.code,
        lines: dto.lines.map((line) => ({
          skuId: line.skuId,
          orderedQty: line.orderedQty,
          unitCostPaise: line.unitCostPaise,
          expectedDate: line.expectedDate,
        })),
      },
      key,
    );
    return { purchaseOrder: { ...snapshot.purchaseOrder } };
  }

  @Get(':tenantId/warehouses/:warehouseId/inbound/purchase-orders')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's purchase orders, status-filterable (keyset cursor pagination)",
  })
  @ApiOkResponse({
    type: PurchaseOrderListResponse,
    description: 'The warehouse\'s PO page (headers only — the detail read carries the lines; keyset cursor)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listPurchaseOrders(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: PurchaseOrderListQuery,
  ): Promise<PurchaseOrderListResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) warehouseId is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(warehouseId, 'warehouseId');
    const listQuery: ListPurchaseOrdersQuery = {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.inbound.listPurchaseOrders(tenantId, warehouseId, listQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/inbound/purchase-orders/:poId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One purchase order's detail — per line the ordered / received-to-date / open quantities at all times",
  })
  @ApiOkResponse({
    type: PurchaseOrderResponse,
    description: 'The PO with its lines (oldest first); a closed PO keeps its close dispositions and quantities queryable exactly as at close',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed poId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No purchase order with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'poId', format: 'uuid' })
  async getPurchaseOrder(
    @Param('tenantId') tenantId: string,
    @Param('poId') poId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<PurchaseOrderResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) path param is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(poId, 'poId');
    const po = await this.inbound.getPurchaseOrder(tenantId, poId);
    if (po === null) {
      throw purchaseOrderNotFound(poId);
    }
    return { purchaseOrder: { ...po } };
  }

  @Patch(':tenantId/inbound/purchase-orders/:poId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Amends an open purchase order (po.manage) — the full line set: update by id, add without id, remove by absence',
  })
  @ApiBody({ type: AmendPurchaseOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: PurchaseOrderResponse,
    description: 'PO amended: ordered / open recomputed, receivedQty untouched (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or a non-positive qty / unit cost / malformed expectedDate (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks po.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('PO or a referenced line id does not exist in this tenant (not-found), or a line\'s SKU is unknown (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The PO is not open (po-not-open, naming the status), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'poId', format: 'uuid' })
  async amendPurchaseOrder(
    @Param('tenantId') tenantId: string,
    @Param('poId') poId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AmendPurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(poId, 'poId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.amendPurchaseOrder(
      {
        tenantId,
        actorUserId: session.userId,
        poId,
        lines: dto.lines.map((line) => ({
          ...(line.id === undefined ? {} : { id: line.id }),
          skuId: line.skuId,
          orderedQty: line.orderedQty,
          unitCostPaise: line.unitCostPaise,
          ...(line.expectedDate === undefined ? {} : { expectedDate: line.expectedDate }),
        })),
      },
      key,
    );
    return { purchaseOrder: { ...snapshot.purchaseOrder } };
  }

  @Post(':tenantId/inbound/purchase-orders/:poId/close')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Closes a purchase order (po.manage) with a per-line disposition — carried open quantities auto-create one successor open PO',
  })
  @ApiBody({ type: ClosePurchaseOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: PurchaseOrderCloseResponse,
    description: 'The closed PO (lines show their dispositions) plus the successor PO when ≥1 line was carried (null otherwise)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, a missing/duplicate line disposition, or a carried line with no open quantity (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks po.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('PO or a dispositioned line id does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The PO is already closed (po-not-open, naming the status), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'poId', format: 'uuid' })
  async closePurchaseOrder(
    @Param('tenantId') tenantId: string,
    @Param('poId') poId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ClosePurchaseOrderDto,
  ): Promise<PurchaseOrderCloseResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(poId, 'poId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.closePurchaseOrder(
      {
        tenantId,
        actorUserId: session.userId,
        poId,
        lines: dto.lines.map((line) => ({ lineId: line.lineId, disposition: line.disposition })),
      },
      key,
    );
    return {
      purchaseOrder: { ...snapshot.purchaseOrder },
      successor: snapshot.successor === null ? null : { ...snapshot.successor },
    };
  }
}

/** Inbound uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'poId' | 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}

function purchaseOrderNotFound(poId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Purchase order not found',
    `No purchase order with id "${poId}" exists in this tenant.`,
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