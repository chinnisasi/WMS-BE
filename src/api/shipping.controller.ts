import { Body, Controller, createParamDecorator, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {} from 'multer';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { ATTACHMENT_UPLOAD_LIMITS, AttachmentUploadFilter, CLIENT_LABEL_UPLOAD_LIMITS } from '../shared/import/attachment-upload-filter';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import { AnySessionGuard, CurrentAnySession, type AnySession } from '../modules/tenancy/any-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
// Bound to @Body() / @Query() — value imports (the ValidationPipe reads the classes).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ClientLabelUploadFieldsDto,
  ClientShipmentResponse,
  CreateHandoverDto,
  HandoverCandidatesResponse,
  HandoverDetailResponse,
  HandoverPhotoFieldsDto,
  HandoverResponse,
  HandoversResponse,
  OrderDocumentFieldsDto,
  OrderShippingResponse,
  ParcelTagQueryDto,
  RecordAwbAdviceDto,
  RemoveShippingFileDto,
  ShippingFileResponse,
  StagedPhotoResponse,
  VerifyLabelDto,
  VerifyLabelResponse,
  VoidShipmentDto,
} from './shipping.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID (26 chars, Crockford base32) — replays return the original result',
    schema: { type: 'string' },
  },
];

const TENANT_PARAM = { name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' } as const;

/** The `x-op-operator` header (the 2-5a decorator shape — never `@Headers()`, guide §8). */
const OpOperatorHeader = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const value = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers['x-op-operator'];
  return typeof value === 'string' ? value : undefined;
});

/**
 * Story 4-4a — client-arranged shipping, the staff and handheld routes: the
 * client label and AWB, the void, the label verification, the documents and
 * the signed sheet, the courier handover, the parcel tag and the reads. The
 * portal twins live in `portal.controller.ts` (its scans). Every write is a
 * keyed command; every read is ungated (the handover phone excepted).
 */
@ApiTags('shipping')
@Controller('tenants')
export class ShippingController {
  constructor(@Inject(OutboundFacade) private readonly outbound: OutboundFacade) {}

  // ── A8, A9, A10: the client's label, the AWB, the void ─────────────────────

  @Post(':tenantId/outbound/orders/:orderId/shipment/client-label')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: CLIENT_LABEL_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Story 4-4a — labels.execute: records the client’s own label PDF and its AWB for an open order (the client’s courier). The PDF is re-serialised (annotations, actions and JavaScript dropped) and stored; the shipment is client-label, labelled. With replace=true a live client label or AWB is voided first.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'The label PDF (≤ 10 MB, 1–50 pages, not password-protected)' },
        awb: { type: 'string' },
        courierName: { type: 'string' },
        transporterId: { type: 'string', format: 'uuid' },
        packageCount: { type: 'string', description: '1–999' },
        replace: { type: 'string', enum: ['true'] },
      },
      required: ['file', 'awb'],
    },
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientShipmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed AWB, courier (exactly one of a transporter and a name), parcel count, key or part (validation-failed)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('The caller lacks labels.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order or transporter (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not open (order-not-open); it has a carrier label or a live client label without replace (shipment-exists, naming the AWB); its parcel was handed over (shipment-handed-over); the AWB is on another open order of this client (awb-in-use); the partner is not an active transporter') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Password-protected or unreadable (pdf-unreadable), over 50 pages (pdf-too-many-pages), over 10 MB (attachment-too-large), or the key reused (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('No file storage (file-storage-unavailable), the store failed (file-storage-failed), or too many uploads (file-storage-busy)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async recordClientLabel(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() fields: ClientLabelUploadFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ClientShipmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.recordClientLabel(
      {
        tenantId,
        actorUserId: session.userId,
        orderId,
        awb: fields.awb,
        courierName: fields.courierName,
        transporterId: fields.transporterId,
        packageCount: parseCountField(fields.packageCount),
        replace: parseReplaceField(fields.replace),
        bytes: file?.buffer,
      },
      key,
    );
    return { shipment: { ...snapshot.shipment } };
  }

  @Post(':tenantId/outbound/orders/:orderId/shipment/awb')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — labels.execute: pre-advises the AWB the client’s courier will bring (no file); the shipment is courier-label, labelled' })
  @ApiBody({ type: RecordAwbAdviceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientShipmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed AWB, courier, count or key (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order or transporter (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('order-not-open, shipment-exists, shipment-handed-over, awb-in-use') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async recordAwbAdvice(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordAwbAdviceDto,
  ): Promise<ClientShipmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.recordAwbAdvice(
      {
        tenantId,
        actorUserId: session.userId,
        orderId,
        awb: dto.awb,
        courierName: dto.courierName,
        transporterId: dto.transporterId,
        packageCount: dto.packageCount,
        replace: dto.replace,
      },
      key,
    );
    return { shipment: { ...snapshot.shipment } };
  }

  @Post(':tenantId/outbound/orders/:orderId/shipment/void')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — labels.execute: voids the order’s client-arranged shipment before its handover (its label file removed with the reason)' })
  @ApiBody({ type: VoidShipmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientShipmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A reason outside 1–200 characters (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order, or no live shipment (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A carrier label (shipment-not-client-arranged), or handed over (shipment-handed-over)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async voidShipment(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: VoidShipmentDto,
  ): Promise<ClientShipmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.voidClientArrangedShipment({ tenantId, actorUserId: session.userId, orderId, reason: dto.reason }, key);
    return { shipment: { ...snapshot.shipment } };
  }

  // ── A11: the label verification (web or handheld) ─────────────────────────

  @Post(':tenantId/outbound/orders/:orderId/shipment/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Story 4-4a — pack.execute: the client label scanned (or typed) onto the parcel must read the order’s AWB. Either session family: the web, or the handheld’s queued shipment.verify-label op (badge-in required; occurredAt required). A second verification is a no-op that stores the key.',
  })
  @ApiBody({ type: VerifyLabelDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: VerifyLabelResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A blank scan, an unknown method, or (device) no occurredAt (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not open (order-not-open); no client label to verify (no-client-label)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The label reads another AWB (label-mismatch, extensions.scanned), or the key reused (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async verifyLabel(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: VerifyLabelDto,
  ): Promise<VerifyLabelResponse> {
    assertOwnTenant(session.session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const surface =
      session.family === 'device'
        ? { kind: 'device' as const, deviceId: session.session.deviceId, operatorUserId: badgedIn(session.session), occurredAt: dto.occurredAt }
        : { kind: 'web' as const, actorUserId: session.session.userId };
    const snapshot = await this.outbound.verifyClientLabel({ tenantId, orderId, scannedCode: dto.scannedCode, method: dto.method, surface }, key);
    return { shipment: { ...snapshot.shipment }, verified: snapshot.verified };
  }

  // ── A16: the order's shipping and its parcel tag ─────────────────────────

  @Get(':tenantId/outbound/orders/:orderId/shipping')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — the order’s shipping (any staff role): the live shipment, the voided ones, the client label, the documents, the handover and its signed sheet (short-lived presigned URLs), and the parcel tag code' })
  @ApiOkResponse({ type: OrderShippingResponse })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async orderShipping(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderShippingResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const view = await this.outbound.getOrderShipping(tenantId, orderId);
    if (view === null) throw notFound('Order', orderId);
    return JSON.parse(JSON.stringify(view)) as OrderShippingResponse;
  }

  @Get(':tenantId/outbound/orders/:orderId/parcel-tag')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — the parcel tag (4×2 only): ZPL or PDF. The barcode is the tag code (`O` + the order id’s last 16 hex digits). A file read: no key, no audit' })
  @ApiQuery({ name: 'format', required: false, enum: ['zpl', 'pdf'] })
  @ApiProduces('application/pdf', 'text/plain')
  @ApiResponse({ status: 200, description: 'The tag file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'text/plain': { schema: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not accepted or ready to dispatch (order-not-open)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async parcelTag(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Query() query: ParcelTagQueryDto,
    @CurrentSession() session: TenantSession,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const file = await this.outbound.renderParcelTag(tenantId, orderId, query.format ?? 'pdf');
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', String(file.body.byteLength));
    res.end(file.body);
  }

  // ── A14: documents, the signed sheet, the handheld photo, remove ─────────

  @Post(':tenantId/outbound/orders/:orderId/documents')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-4a — dispatch.execute: attaches a shipping document to an order (an image or a PDF; invoice, challan, eway-bill, pod or other). Shared with the client by email at once when the order is dispatched, else at its dispatch' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['invoice', 'challan', 'eway-bill', 'pod', 'other'] } }, required: ['file', 'kind'] } })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ShippingFileResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing file or an unknown kind (validation-failed)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown order (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A cancelled order (order-not-open), or 20 live warehouse documents already (document-limit)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a JPEG, PNG, WebP or PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('attachment-too-large, attachment-content-invalid, pdf-unreadable, pdf-too-many-pages, idempotency-key-reuse') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async uploadOrderDocument(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() fields: OrderDocumentFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ShippingFileResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.uploadOrderDocument({ tenantId, actorUserId: session.userId, orderId, kind: fields.kind, bytes: file?.buffer }, key);
    return { file: { ...snapshot.file } };
  }

  @Post(':tenantId/outbound/handovers/:handoverId/sheet')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-4a — dispatch.execute: attaches a signed handover sheet page (an image or a PDF, ≤ 10 pages per handover); emailed to the client’s opted-in contacts' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ShippingFileResponse })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown handover (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('10 live pages already (handover-sheet-limit)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not an image or a PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('attachment-too-large, attachment-content-invalid, pdf-unreadable, pdf-too-many-pages, idempotency-key-reuse') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'handoverId', format: 'uuid' })
  async uploadHandoverSheet(
    @Param('tenantId') tenantId: string,
    @Param('handoverId') handoverId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ShippingFileResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(handoverId, 'handoverId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.uploadHandoverSheet({ tenantId, actorUserId: session.userId, handoverId, bytes: file?.buffer }, key);
    return { file: { ...snapshot.file } };
  }

  @Post(':tenantId/outbound/handover-photos')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-4a — the handheld’s signed-sheet photo (handover-photo.stage; the device credential + x-op-operator). Idempotency-Key = the photo ULID its handover names in photoRefs; bound to the handover in either order (2-5a’s fate table)' })
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
  async stageHandoverPhoto(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @OpOperatorHeader() opOperator: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() fields: HandoverPhotoFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<StagedPhotoResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const ref = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.stageHandoverPhoto(
      { tenantId, deviceId: session.deviceId, opOperator, capturedAt: fields.capturedAt, bytes: file?.buffer },
      ref,
    );
    return { ref: snapshot.ref, status: snapshot.status };
  }

  @Post(':tenantId/outbound/shipping-files/:attachmentId/remove')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — orders.manage: removes a shipping document or a signed-sheet page (soft — the bytes are purged after ATTACHMENT_PURGE_DAYS). A live client label is removed only by voiding or replacing its shipment' })
  @ApiBody({ type: RemoveShippingFileDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ShippingFileResponse })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown file (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A live client label (label-in-use), or already removed (attachment-not-attached)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'attachmentId', format: 'uuid' })
  async removeShippingFile(
    @Param('tenantId') tenantId: string,
    @Param('attachmentId') attachmentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RemoveShippingFileDto,
  ): Promise<ShippingFileResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(attachmentId, 'attachmentId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.removeShippingFile({ tenantId, actorUserId: session.userId, attachmentId, reason: dto.reason }, key);
    return { file: { ...snapshot.file } };
  }

  // ── A12: the courier handover ─────────────────────────────────────────────

  @Post(':tenantId/outbound/handovers')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Story 4-4a — dispatch.execute: hands parcels of ONE client to its courier and DISPATCHES every order handed over, in one transaction. Web: all-or-nothing (409 handover-parcels-refused naming each parcel). Handheld (badge-in; occurredAt required): the passing parcels settle and the refused ones go into one Discard-only review row',
  })
  @ApiBody({ type: CreateHandoverDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: HandoverResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A duplicate order or AWB, a malformed AWB, phone, vehicle, weight, count or time, more than 100 parcels, photoRefs on the web, a pickup time outside the last 7 days on the web (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('The caller lacks dispatch.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse, client or transporter (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A parcel of another client (handover-client-mismatch, extensions.orderIds); the client departed (client-departed); web: refused parcels (handover-parcels-refused, extensions.parcels[{orderId, code, detail}]); an AWB taken concurrently, or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  async handOver(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: CreateHandoverDto,
  ): Promise<HandoverResponse> {
    assertOwnTenant(session.session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const surface =
      session.family === 'device'
        ? { kind: 'device' as const, deviceId: session.session.deviceId, operatorUserId: badgedIn(session.session) }
        : { kind: 'web' as const, actorUserId: session.session.userId };
    const snapshot = await this.outbound.handOver(
      {
        tenantId,
        surface,
        warehouseId: dto.warehouseId,
        clientId: dto.clientId,
        courier: dto.courier,
        pickupPersonName: dto.pickupPersonName,
        pickupPersonPhone: dto.pickupPersonPhone,
        vehicleNumber: dto.vehicleNumber,
        occurredAt: dto.occurredAt,
        note: dto.note,
        parcels: dto.parcels,
        photoRefs: dto.photoRefs,
      },
      key,
    );
    return JSON.parse(JSON.stringify(snapshot)) as HandoverResponse;
  }

  @Get(':tenantId/outbound/handovers/:handoverId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — one courier handover (any staff role): the frozen parties, the parcels, the signed sheet; the pickup phone unmasked for a dispatch.execute holder only' })
  @ApiOkResponse({ type: HandoverDetailResponse })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown handover (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'handoverId', format: 'uuid' })
  async handover(
    @Param('tenantId') tenantId: string,
    @Param('handoverId') handoverId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<HandoverDetailResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(handoverId, 'handoverId');
    const view = await this.outbound.getHandover(tenantId, handoverId, session.userId);
    if (view === null) throw notFound('Handover', handoverId);
    return { handover: JSON.parse(JSON.stringify(view)) as HandoverDetailResponse['handover'] };
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/handover-candidates')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — the handover builder’s list: one client’s packed orders in the warehouse, oldest first (keyset), with each parcel’s shipment and tag code' })
  @ApiQuery({ name: 'clientId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } })
  @ApiOkResponse({ type: HandoverCandidatesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A missing clientId or a malformed cursor (validation-failed, invalid-cursor)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async handoverCandidates(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Query('clientId') clientId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<HandoverCandidatesResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    const page = await this.outbound.getHandoverCandidates(tenantId, warehouseId, clientId ?? '', { cursor, limit: parseLimit(limit) });
    return JSON.parse(JSON.stringify(page)) as HandoverCandidatesResponse;
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/handovers')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — the warehouse’s courier handovers, newest first (keyset); from/to are IST dates, inclusive' })
  @ApiQuery({ name: 'clientId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } })
  @ApiOkResponse({ type: HandoversResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed date, client or cursor (validation-failed, invalid-cursor)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Unknown warehouse (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async handovers(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Query('clientId') clientId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<HandoversResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuid(warehouseId, 'warehouseId');
    const page = await this.outbound.listHandovers(tenantId, warehouseId, { clientId, from, to, cursor, limit: parseLimit(limit) });
    return JSON.parse(JSON.stringify(page)) as HandoversResponse;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function notFound(subject: string, id: string): ProblemException {
  return new ProblemException('not-found', 404, `${subject} not found`, `No ${subject.toLowerCase()} with id "${id}" exists in this tenant.`);
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

/** A multipart `packageCount` (text): absent → undefined; a whole number → it; anything else → 400. */
export function parseCountField(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d{1,4}$/.test(raw.trim())) {
    throw new ProblemException('validation-failed', 400, 'Invalid parcel count', 'packageCount must be a whole number of parcels, 1–999.');
  }
  return Number(raw.trim());
}

/** A multipart `replace` (text): absent → false; `true` → true; anything else → 400. */
export function parseReplaceField(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'false') return false;
  if (raw.trim() === 'true') return true;
  throw new ProblemException('validation-failed', 400, 'Invalid replace', 'replace must be "true" (or absent).');
}
