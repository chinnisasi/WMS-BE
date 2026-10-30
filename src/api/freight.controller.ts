import { Body, Controller, createParamDecorator, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {} from 'multer';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { ATTACHMENT_UPLOAD_LIMITS, AttachmentUploadFilter } from '../shared/import/attachment-upload-filter';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import { AnySessionGuard, CurrentAnySession, type AnySession } from '../modules/tenancy/any-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { sendDocumentFile } from './outbound.controller';
// Bound to @Body() / @Query() — value imports (the ValidationPipe reads the classes).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateFreightLoadDto,
  DispatchFreightLoadDto,
  FreightCandidatesQueryDto,
  FreightCandidatesResponse,
  FreightConsignmentResponse,
  FreightDispatchResponse,
  FreightLoadResponse,
  FreightLoadsQueryDto,
  FreightLoadsResponse,
  FreightLoadViewDto,
  FreightOrderIdsDto,
  FreightPdfQueryDto,
  FreightPhotoFieldsDto,
  FreightReasonDto,
  FreightScanDto,
  FreightScanResponse,
  RecordFreightDeliveryDto,
  RecordFreightLrDto,
  UpdateFreightLoadDto,
} from './freight.dto';
import { ShippingFileResponse, StagedPhotoResponse } from './shipping.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID (26 chars, Crockford base32) — replays return the original result',
    schema: { type: 'string' },
  },
];

const TENANT_PARAM = { name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' } as const;
const LOAD_PARAM = { name: 'loadId', format: 'uuid' } as const;
const CONSIGNMENT_PARAM = { name: 'consignmentId', format: 'uuid' } as const;
const PDF_CONTENT = { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } as const;

/** The `x-op-operator` header (the 2-5a decorator shape — never `@Headers()`, guide §8). */
const OpOperatorHeader = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const value = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers['x-op-operator'];
  return typeof value === 'string' ? value : undefined;
});

/**
 * Story 4-9a (D14) — B2B freight dispatch: the load, its orders and stops,
 * the per-package scan (web or handheld), the departure (web or handheld),
 * the cancel, the signed loading sheet and the handheld's sheet photos, the
 * LR and the proof of delivery, the reads and the two prints. Every write is
 * a keyed command (`dispatch.execute`; a delivery amendment `orders.manage`);
 * every read is ungated. Literal sub-paths are declared before any `:param`
 * sibling (guide §6, the 8-2a gotcha).
 */
@ApiTags('freight')
@Controller('tenants')
export class FreightController {
  constructor(@Inject(OutboundFacade) private readonly outbound: OutboundFacade) {}

  // ── the warehouse's loads and candidates ───────────────────────────────

  @Post(':tenantId/warehouses/:warehouseId/outbound/freight-loads')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A9) — dispatch.execute: a freight load (LD-NNNN) — FTL or LTL, one transporter (a partner or a typed name), the vehicle and driver so far, the dock door, and optionally its first orders (all-or-nothing)' })
  @ApiBody({ type: CreateFreightLoadDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: FreightLoadResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed field (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Role lacks dispatch.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse or transporter (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('freight-orders-refused (orders[{orderId, code}]), load-full, partner-not-transporter, transporter-inactive') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async createLoad(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateFreightLoadDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.createFreightLoad({ ...dto, tenantId, actorUserId: session.userId, warehouseId }, key));
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/freight-loads')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A20, A68) — a warehouse’s freight loads, newest first: open (default), dispatched, pod-pending, delivery-exceptions, cancelled; clientId filters to loads holding that client’s orders; from/to are IST dates over created (open, cancelled) or departed (the others)' })
  @ApiOkResponse({ type: FreightLoadsResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter or cursor (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listLoads(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Query() query: FreightLoadsQueryDto,
    @CurrentSession() session: TenantSession,
  ): Promise<FreightLoadsResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    return plain(
      await this.outbound.listFreightLoads(tenantId, warehouseId, {
        view: query.view,
        clientId: query.clientId,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: parseLimit(query.limit),
      }),
    );
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/freight-candidates')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A20) — the orders a load may take: the warehouse’s accepted or packed orders on no truck and with no live label, packed first, at most 2,000 scanned (truncated); filters client, state, city, pincode, packed/accepted' })
  @ApiOkResponse({ type: FreightCandidatesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter or cursor (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async candidates(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Query() query: FreightCandidatesQueryDto,
    @CurrentSession() session: TenantSession,
  ): Promise<FreightCandidatesResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    return plain(
      await this.outbound.freightCandidates(tenantId, warehouseId, {
        clientId: query.clientId,
        state: query.state,
        city: query.city,
        pincode: query.pincode,
        status: query.status,
        cursor: query.cursor,
        limit: parseLimit(query.limit),
      }),
    );
  }

  // ── the handheld's sheet photo (a literal route before the :loadId family) ─

  @Post(':tenantId/outbound/freight-photos')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-9a (A18) — the handheld’s signed loading-sheet photo (freight-photo.stage; the device credential + x-op-operator). Idempotency-Key = the photo ULID its departure names in photoRefs; bound to the load in either order (2-5a’s fate table). Never shared with a client' })
  @ApiBody({ schema: { type: 'object', properties: { capturedAt: { type: 'string', format: 'date-time' }, file: { type: 'string', format: 'binary' } }, required: ['capturedAt', 'file'] } })
  @ApiHeaders([
    ...IDEMPOTENCY_HEADER,
    { name: 'x-op-operator', required: true, description: 'The capturing operator’s user id', schema: { type: 'string', format: 'uuid' } },
  ])
  @ApiResponse({ status: HttpStatus.CREATED, type: StagedPhotoResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed key, x-op-operator, capturedAt or file (validation-failed)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The ref is stored with different bytes or another purpose (attachment-ref-conflict)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a JPEG, PNG or WebP (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('attachment-too-large, attachment-content-invalid, idempotency-key-reuse') })
  @ApiResponse({ status: 429, ...problemJsonResponse('200 photos waiting on this device (attachment-staging-limit)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam(TENANT_PARAM)
  async stageFreightPhoto(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @OpOperatorHeader() opOperator: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() fields: FreightPhotoFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<StagedPhotoResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const ref = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.stageFreightPhoto({ tenantId, deviceId: session.deviceId, opOperator, capturedAt: fields.capturedAt, bytes: file?.buffer }, ref);
    return { ref: snapshot.ref, status: snapshot.status };
  }

  // ── one load: literal sub-paths first ─────────────────────────────────

  @Post(':tenantId/outbound/freight-loads/:loadId/orders/:orderId/remove')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A11) — dispatch.execute: take a planned order off an open load (its scans unloaded); the other stops keep their numbers' })
  @ApiBody({ type: FreightReasonDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightLoadResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('No reason (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load, or the order is not planned on it (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-not-open') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async removeOrder(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: FreightReasonDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.removeFreightOrder({ tenantId, actorUserId: session.userId, loadId, orderId, reason: dto.reason }, key));
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/orders')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A10) — dispatch.execute: plan orders on an open load (all-or-nothing; one order rides one truck, whole)' })
  @ApiBody({ type: FreightOrderIdsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightLoadResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed or duplicate order id (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-not-open, load-full, freight-orders-refused (order-not-found, warehouse-mismatch, order-not-open, order-on-freight-load, order-has-courier-shipment)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async addOrders(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: FreightOrderIdsDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.addFreightOrders({ tenantId, actorUserId: session.userId, loadId, orderIds: dto.orderIds }, key));
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/stops')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A12) — dispatch.execute: the planned orders in delivery order (stop 1 first; loaded last stop first). The same order is a no-op that stores the key' })
  @ApiBody({ type: FreightOrderIdsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightLoadResponse })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-not-open, freight-members-changed (extensions.orderIds)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async reorderStops(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: FreightOrderIdsDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.reorderFreightStops({ tenantId, actorUserId: session.userId, loadId, orderIds: dto.orderIds }, key));
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/scans')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Story 4-9a (A13, A44, A45) — dispatch.execute: one package loaded onto (or unloaded from) the truck. Either session family: the web (a tick or a wedge scan), or the handheld’s freight.load-scan op (badge-in, occurredAt and warehouseId required). A package already loaded is a no-op that stores the key (200 semantics in a 201: alreadyLoaded). A scan taken before the departure and synced after counts',
  })
  @ApiBody({ type: FreightScanDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: FreightScanResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A blank code, an unknown action, no unload reason, occurredAt on the web (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token, or a device token without a badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-dispatched, load-cancelled, package-not-on-load (extensions.loadCode), carton-not-current, order-not-packed, consignment-removed, warehouse-mismatch') })
  @ApiResponse({ status: 422, ...problemJsonResponse('package-code-invalid, package-code-ambiguous, idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async recordScan(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: FreightScanDto,
  ): Promise<FreightScanResponse> {
    assertOwnTenant(session.session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const surface =
      session.family === 'device'
        ? { kind: 'device' as const, deviceId: session.session.deviceId, operatorUserId: badgedIn(session.session) }
        : { kind: 'web' as const, actorUserId: session.session.userId };
    return plain(
      await this.outbound.recordFreightScan(
        { tenantId, surface, loadId, packageCode: dto.packageCode, action: dto.action, occurredAt: dto.occurredAt, reason: dto.reason, warehouseId: dto.warehouseId },
        key,
      ),
    );
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/dispatch')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Story 4-9a (A14) — dispatch.execute: the truck leaves. Records the vehicle, driver, seals and the e-way Part B confirmation, decides each consignment (dispatch or leave), freezes the parties and dispatches every order sent through the shared dispatch body (4-6a’s gate judged once per order). The web is all-or-nothing; the handheld’s freight.dispatch op settles partially (the orders that left but could not be dispatched become one Discard-only review row)',
  })
  @ApiBody({ type: DispatchFreightLoadDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: FreightDispatchResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed field, no dispatch decision, an LR shared by two clients, a departure before the loading (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token, or a device token without a badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'load-dispatched, load-cancelled, freight-members-changed, freight-orders-refused (orders[{orderId, code}]), eway-part-b-unconfirmed, load-over-capacity, eway-threshold-missing, transporter-inactive, partner-not-transporter, warehouse-mismatch, client-departed',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async dispatchLoad(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: DispatchFreightLoadDto,
  ): Promise<FreightDispatchResponse> {
    assertOwnTenant(session.session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const surface =
      session.family === 'device'
        ? { kind: 'device' as const, deviceId: session.session.deviceId, operatorUserId: badgedIn(session.session) }
        : { kind: 'web' as const, actorUserId: session.session.userId };
    return plain(await this.outbound.dispatchFreightLoad({ ...dto, tenantId, surface, loadId }, key));
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A15) — dispatch.execute: cancel an open load — every planned order is taken off (its scans unloaded); the orders themselves are untouched' })
  @ApiBody({ type: FreightReasonDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightLoadResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('No reason (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-not-open') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async cancelLoad(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: FreightReasonDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.cancelFreightLoad({ tenantId, actorUserId: session.userId, loadId, reason: dto.reason }, key));
  }

  @Post(':tenantId/outbound/freight-loads/:loadId/sheet')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-9a (A18, A57) — dispatch.execute: a page of the signed loading sheet (an image or a PDF; ≤ 10 live pages). Never shared with a client (a multi-client document)' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ShippingFileResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('No file (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('loading-sheet-limit, load-cancelled') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not an image or a PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('attachment-too-large, attachment-content-invalid, pdf-unreadable, pdf-too-many-pages, idempotency-key-reuse') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async uploadSheet(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ShippingFileResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.uploadLoadingSheet({ tenantId, actorUserId: session.userId, loadId, bytes: file?.buffer }, key);
    return { file: { ...snapshot.file } };
  }

  @Get(':tenantId/outbound/freight-loads/:loadId/loading-sheet')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A25) — the A4 loading sheet (landscape): a plan before departure (watermarked), final after. Staff and the transporter only. A file read: no key, no audit' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'The loading sheet', content: PDF_CONTENT })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-cancelled') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async loadingSheet(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @Query() _query: FreightPdfQueryDto,
    @CurrentSession() session: TenantSession,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    sendPdf(res, await this.outbound.renderLoadingSheet(tenantId, loadId));
  }

  @Get(':tenantId/outbound/freight-loads/:loadId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A21) — one freight load: the vehicle, driver (the phone and licence unmasked for dispatch.execute), seals, Part B, totals, each consignment with its loading progress, gate, LR and delivery, the removed orders and the signed sheet pages' })
  @ApiOkResponse({ type: FreightLoadViewDto })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async loadDetail(@Param('tenantId') tenantId: string, @Param('loadId') loadId: string, @CurrentSession() session: TenantSession): Promise<FreightLoadViewDto> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const view = await this.outbound.freightLoadDetail(tenantId, loadId, session.userId);
    if (view === null) throw new ProblemException('not-found', 404, 'Freight load not found', `No freight load with id "${loadId}" exists in this tenant.`);
    return plain(view);
  }

  @Post(':tenantId/outbound/freight-loads/:loadId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A9) — dispatch.execute: edit an open load’s header (a full replacement). Unchanged is a no-op that stores the key' })
  @ApiBody({ type: UpdateFreightLoadDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightLoadResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed field (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown load or transporter (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('load-not-open, partner-not-transporter, transporter-inactive') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(LOAD_PARAM)
  async updateLoad(
    @Param('tenantId') tenantId: string,
    @Param('loadId') loadId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateFreightLoadDto,
  ): Promise<FreightLoadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(loadId, 'loadId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.updateFreightLoad({ ...dto, tenantId, actorUserId: session.userId, loadId }, key));
  }

  // ── one consignment ───────────────────────────────────────────────────

  @Post(':tenantId/outbound/freight-consignments/:consignmentId/lr')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A16, A49) — dispatch.execute: the consignment’s lorry receipt (captured, never issued); after departure a change needs a reason. One LR covers one client’s goods on a load. Unchanged is a no-op (200, unchanged: true)' })
  @ApiBody({ type: RecordFreightLrDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightConsignmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed LR or date, a second client’s LR, no reason after departure (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown consignment (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('consignment-removed') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CONSIGNMENT_PARAM)
  async recordLr(
    @Param('tenantId') tenantId: string,
    @Param('consignmentId') consignmentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordFreightLrDto,
  ): Promise<FreightConsignmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(consignmentId, 'consignmentId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.recordFreightLr({ ...dto, tenantId, actorUserId: session.userId, consignmentId }, key));
  }

  @Post(':tenantId/outbound/freight-consignments/:consignmentId/delivery')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A17, A48) — dispatch.execute: the proof of delivery — delivered, delivered with exceptions (short / damaged, a note) or refused (a note). The order stays dispatched. Amending a recorded delivery needs orders.manage and a reason; unchanged is a no-op (200, unchanged: true)' })
  @ApiBody({ type: RecordFreightDeliveryDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: FreightConsignmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed field, a delivery before the departure or in the future, more short + damaged than packages, no reason on an amendment (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('role-denied (an amendment by a dispatch.execute-only role: "Only an office role can amend a recorded delivery")') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown consignment (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('consignment-not-dispatched, delivery-amend-limit') })
  @ApiResponse({ status: 422, ...problemJsonResponse('idempotency-key-reuse') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CONSIGNMENT_PARAM)
  async recordDelivery(
    @Param('tenantId') tenantId: string,
    @Param('consignmentId') consignmentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordFreightDeliveryDto,
  ): Promise<FreightConsignmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(consignmentId, 'consignmentId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return plain(await this.outbound.recordFreightDelivery({ ...dto, tenantId, actorUserId: session.userId, consignmentId }, key));
  }

  @Get(':tenantId/outbound/freight-consignments/:consignmentId/note')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-9a (A26) — the staff freight note of a dispatched consignment (portrait A4; the package codes and the barcode). A file read: no key, no audit' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'The freight note', content: PDF_CONTENT })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown consignment (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('consignment-not-dispatched') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CONSIGNMENT_PARAM)
  async freightNote(
    @Param('tenantId') tenantId: string,
    @Param('consignmentId') consignmentId: string,
    @Query() _query: FreightPdfQueryDto,
    @CurrentSession() session: TenantSession,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(consignmentId, 'consignmentId');
    sendPdf(res, await this.outbound.renderFreightNote(tenantId, consignmentId));
  }
}

/** A snapshot as a plain JSON value (the DTO classes describe it; nothing is spread from an operator view). */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The staff PDFs go out through 4-5a's document sender (no-store, the length, the attachment name). */
function sendPdf(res: Response, file: { body: Buffer; fileName: string }): void {
  sendDocumentFile(res, { filename: file.fileName, contentType: 'application/pdf', body: file.body });
}

function assertOwnTenant(sessionTenantId: string, tenantId: string): void {
  if (sessionTenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `${name} must be a uuid`, `The "${name}" path parameter must be a uuid (got "${value}").`);
  }
}

/** The device arm is badge-in required (a bare enrollment credential carries no operator). */
function badgedIn(session: DeviceSession): string {
  if (session.userId === null) {
    throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
  }
  return session.userId;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ProblemException('validation-failed', 400, 'Invalid limit', 'limit must be a positive integer.');
  return n;
}
