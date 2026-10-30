import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { parsePackageLabelQuery } from '../shared/labels/shipping/package-labels-file';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { VendorReturnFacade } from '../modules/inbound/vendor-return.facade';
import type { VendorReturnView } from '../modules/inbound/vendor-return.read';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelVendorReturnDto,
  CreateVendorReturnDto,
  DispatchVendorReturnDto,
  PackageLabelQueryDto,
  PickVendorReturnDto,
  ReturnableDamagedQuery,
  ReturnableDamagedResponse,
  VendorReturnDto,
  VendorReturnListQuery,
  VendorReturnListResponse,
} from '../modules/inbound/vendor-return.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)';
const MANAGE_403 = 'Session belongs to another tenant (permission-denied), the caller lacks rtv.manage (role-denied), or a client-portal session (role-denied — operators only)';

/**
 * Story 2-8b — the return-to-vendor surface: DAMAGED stock (receipt damage,
 * QC fails) back to its vendor. Create and cancel on the web (`rtv.manage`,
 * owner + ops manager), the scan-verified pick on the handheld (`rtv.pick`,
 * the badge-in session, `picks.execute`), the dispatch on the web
 * (`dispatch.execute`) — the one moment stock leaves (`rtv.dispatched`).
 * Member-open reads: the list, one RTV, and one client's returnable DAMAGED
 * stock in a warehouse. Everything goes through `VendorReturnFacade`.
 *
 * No route-order hazard: the only literal sibling (`returnable`) lives under
 * `warehouses/{w}/…`, a different prefix from `vendor-returns/:id`.
 */
@ApiTags('vendor-returns')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class VendorReturnsController {
  constructor(@Inject(VendorReturnFacade) private readonly rtv: VendorReturnFacade) {}

  @Post(':tenantId/vendor-returns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Creates a return to vendor (rtv.manage) — DAMAGED units of one client's SKUs in one warehouse going back to one vendor: the vendor and the brand frozen, each line a DAMAGED arm with an optional source GRN line. Claims the units (no stock moves until dispatch)",
  })
  @ApiBody({ type: CreateVendorReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: VendorReturnDto, description: 'The return to vendor, draft (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing or malformed Idempotency-Key, or an invalid body — no lines or over 200, a repeated (SKU, batch, source), a quantity not above 0 or finer than its unit, an unknown reason, "other" without a note, a note over 500, a batch-tracked SKU without its batch or a batch on an untracked one, or a consignee address the vendor does not have (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, a SKU, a batch, the vendor or the client does not exist in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "A serial-tracked, catch-weight or kit SKU (rtv-sku-unsupported); SKUs of two clients (mixed-client); a departed client (client-departed); the partner is not a vendor, is inactive or is not linked to the client (partner-not-vendor, vendor-inactive, vendor-not-linked); more than DAMAGED holds after the open claims — members onHandQty, claimedQty, availableQty (rtv-exceeds-damaged); the source GRN line's PO is another vendor's (rtv-vendor-mismatch); more than the source can still claim — member claimableQty (rtv-exceeds-source); or a concurrent idempotent request (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse("The source GRN line is not this warehouse's receipt of the line's SKU and batch (rtv-source-mismatch); or the Idempotency-Key reused with a different payload (idempotency-key-reuse)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async create(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateVendorReturnDto,
  ): Promise<VendorReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.rtv.create(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        vendorId: dto.vendorId,
        consigneeAddress: dto.consigneeAddress,
        note: dto.note ?? null,
        // BASE units cross this edge; the command scales them behind its replay lookup.
        lines: dto.lines.map((line) => ({
          skuId: line.skuId,
          batchId: line.batchId ?? null,
          grnLineId: line.grnLineId ?? null,
          quantity: line.quantity,
          reasonCode: line.reasonCode,
        })),
      },
      key,
    );
    return toDto(view);
  }

  @Get(':tenantId/vendor-returns')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists returns to vendor, newest first (keyset cursor), filterable by warehouse, client and status — open to any member' })
  @ApiOkResponse({ type: VendorReturnListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter or limit (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: VendorReturnListQuery,
  ): Promise<VendorReturnListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.rtv.list(tenantId, {
      warehouseId: query.warehouseId,
      clientId: query.clientId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/vendor-returns/:vendorReturnId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One return to vendor — its frozen parties, lines, pick, dispatch capture and cancellation (the printable note reads it) — open to any member' })
  @ApiOkResponse({ type: VendorReturnDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed id (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to vendor in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'vendorReturnId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('vendorReturnId') vendorReturnId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<VendorReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(vendorReturnId);
    return toDto(await this.rtv.get(tenantId, vendorReturnId));
  }

  @Get(':tenantId/vendor-returns/:vendorReturnId/package-labels')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 4-5a — labels.execute: the 4×6 package labels of a picked or dispatched return to vendor, “PACKAGE n/N” — FROM the brand c/o the warehouse, TO the vendor’s frozen address of the RTV’s consignee kind, RETURN TO VENDOR {code}, the carrier and tracking ref once dispatched, and the barcode {code}.{n}. ZPL (203 dpi) first; PDF one 4×6 page per package, or two per landscape A4 sheet',
    description:
      '`format=zpl|pdf` (default zpl), `layout=label|a4` (default label; a4 is PDF only), `count` (required before dispatch; after it, defaults to the dispatched package count), `from`/`to` (a slice, default every package; at most 1,000 labels per print). `Content-Disposition: attachment` — `{code}-package-labels.{zpl|pdf}`.',
  })
  @ApiProduces('text/plain', 'application/pdf')
  @ApiResponse({
    status: 200,
    description: 'The labels: ZPL as `text/plain; charset=us-ascii`, or a PDF',
    content: { 'text/plain': { schema: { type: 'string', format: 'binary' } }, 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed id, format, layout, count, from or to; zpl with the a4 layout; no count before dispatch (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks labels.execute (role-denied) — checked before every path and query value the handler judges (an unknown query key is 400 first, at the ValidationPipe)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to vendor in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Not picked or dispatched (rtv-not-picked); a count other than the dispatched one (package-count-mismatch); the vendor has no address of the consignee kind (consignee-address-missing)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('More than 1,000 labels in one print (too-many-labels — ask for a from/to range)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'vendorReturnId', format: 'uuid' })
  async packageLabels(
    @Param('tenantId') tenantId: string,
    @Param('vendorReturnId') vendorReturnId: string,
    @Query() labelQuery: PackageLabelQueryDto,
    @CurrentSession() session: TenantSession,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenantToken(session.tenantId, tenantId);
    // labels.execute is judged before every value the handler judges (the path id, format, layout,
    // count/from/to/cartons), so a role without it gets 403 whatever those carry — the 2-10b shape.
    // An unknown or repeated query key is answered 400 earlier, by the global ValidationPipe
    // (forbidNonWhitelisted), before this handler runs.
    await this.rtv.assertCanPrintPackageLabels(tenantId, session.userId);
    assertUuidParam(vendorReturnId);
    const file = await this.rtv.packageLabels(tenantId, vendorReturnId, parsePackageLabelQuery(labelQuery));
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.body);
  }

  /** `rtv.pick` — the handheld op (badge-in session; the `Idempotency-Key` is the op's ULID). */
  @Post(':tenantId/vendor-returns/:vendorReturnId/pick')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "rtv.pick — records the handheld's scan-verified pick of a draft return to vendor exactly once (badge-in session, picks.execute): every line with its picked quantity (a short pick is allowed, an empty one refused). Moves no stock — the dispatch does",
  })
  @ApiBody({ type: PickVendorReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: VendorReturnDto, description: 'The return to vendor, picked (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — a malformed id, no lines or a repeated line, a negative or too-fine quantity, a non-UTC occurredAt (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator is not a floor role or lacks picks.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such return to vendor in this tenant, or it is another warehouse's (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('The return to vendor is not a draft — picked, dispatched or cancelled — member status (rtv-not-draft); or a concurrent idempotent request (conflict)') })
  @ApiResponse({
    status: 422,
    ...problemJsonResponse(
      "The lines are not exactly the return's, or a line is picked above its quantity (rtv-pick-mismatch); every line picked 0 (rtv-pick-empty); or the Idempotency-Key reused with a different payload (idempotency-key-reuse)",
    ),
  })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  @ApiParam({ name: 'vendorReturnId', format: 'uuid' })
  async pick(
    @Param('tenantId') tenantId: string,
    @Param('vendorReturnId') vendorReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: PickVendorReturnDto,
  ): Promise<VendorReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    assertUuidParam(vendorReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.rtv.pick(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        vendorReturnId,
        warehouseId: dto.warehouseId,
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line) => ({ lineId: line.lineId, pickedQty: line.pickedQty })),
      },
      key,
    );
    return toDto(view);
  }

  @Post(':tenantId/vendor-returns/:vendorReturnId/dispatch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Dispatches a picked return to vendor (dispatch.execute): records the brand's challan or invoice, the e-way bill, the carrier and the packages, freezes the transporter and the warehouse, and writes one rtv.dispatched draw out of DAMAGED per picked line — the units leave stock",
  })
  @ApiBody({ type: DispatchVendorReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: VendorReturnDto, description: 'The return to vendor, dispatched (the idempotency snapshot)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      "Missing or malformed Idempotency-Key, or an invalid capture — no brand document, an unknown document type, a number over 40, a malformed date or one after today or more than 30 days before the return was created, a malformed or wrong-state consignor GSTIN, an e-way bill number that is not 12 digits or has no date, a validity before the date, none of transporter / carrier name / vehicle, a malformed vehicle, a tracking ref over 50, a package count outside 1–9999 (validation-failed)",
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks dispatch.execute (role-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to vendor, or no such transporter, in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The return to vendor is not picked — member status (rtv-not-picked); the partner is not a transporter or is inactive (partner-not-transporter, transporter-inactive); a reconcile quarantine on DAMAGED (disposition-scope-quarantined); DAMAGED no longer holds the picked units — members onHandQty, pickedQty (rtv-damaged-short); a user location occupies the DAMAGED code (damaged-bin-conflict); or a concurrent idempotent request (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'vendorReturnId', format: 'uuid' })
  async dispatch(
    @Param('tenantId') tenantId: string,
    @Param('vendorReturnId') vendorReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: DispatchVendorReturnDto,
  ): Promise<VendorReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(vendorReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const view = await this.rtv.dispatch(
      {
        tenantId,
        actorUserId: session.userId,
        vendorReturnId,
        brandDocument: dto.brandDocument === undefined ? null : { type: dto.brandDocument.type, number: dto.brandDocument.number, date: dto.brandDocument.date },
        consignorGstin: dto.consignorGstin ?? null,
        debitNoteNumber: dto.debitNoteNumber ?? null,
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

  @Post(':tenantId/vendor-returns/:vendorReturnId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancels a draft or picked return to vendor with a reason (rtv.manage) — its claims on DAMAGED are released; nothing moved, so nothing moves back' })
  @ApiBody({ type: CancelVendorReturnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: VendorReturnDto, description: 'The return to vendor, cancelled (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a blank reason or one over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such return to vendor in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The return to vendor is dispatched or already cancelled — member status (rtv-closed); or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'vendorReturnId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('vendorReturnId') vendorReturnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CancelVendorReturnDto,
  ): Promise<VendorReturnDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(vendorReturnId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return toDto(await this.rtv.cancel({ tenantId, actorUserId: session.userId, vendorReturnId, reason: dto.reason }, key));
  }

  @Get(':tenantId/warehouses/:warehouseId/vendor-returns/returnable')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One client's DAMAGED stock in a warehouse that can go back to a vendor: per arm (SKU, batch) the on-hand, the open return claims and what is available, and the GRN lines the units came from with what each can still claim (newest first) — open to any member",
  })
  @ApiOkResponse({ type: ReturnableDamagedResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId, clientId or skuId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async returnable(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ReturnableDamagedQuery,
  ): Promise<ReturnableDamagedResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId);
    const read = await this.rtv.returnable(tenantId, warehouseId, query.clientId, query.skuId ?? null);
    return {
      warehouseId: read.warehouseId,
      clientId: read.clientId,
      truncated: read.truncated,
      arms: read.arms.map((arm) => ({ ...arm, claimedBy: [...arm.claimedBy], sources: arm.sources.map((source) => ({ ...source })) })),
    };
  }
}

/** The view as the DTO — copied key by key where the DTO has mutable arrays. */
function toDto(view: VendorReturnView): VendorReturnDto {
  return {
    ...view,
    warehouse: { ...view.warehouse },
    lines: view.lines.map((line) => ({ ...line })),
  } as VendorReturnDto;
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
