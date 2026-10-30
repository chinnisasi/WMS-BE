import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// The global `Express.Multer.File` type (FileInterceptor's upload) lives in @types/multer.
import type {} from 'multer';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MAX_SHEET_UPLOAD_BYTES } from '../shared/import/sheet-reader';
import { SheetUploadFilter } from '../shared/import/upload-filter';
import { ATTACHMENT_UPLOAD_LIMITS, AttachmentUploadFilter, CLIENT_LABEL_UPLOAD_LIMITS } from '../shared/import/attachment-upload-filter';
import { parseCountField, parseReplaceField } from './shipping.controller';
// Story 4-4a — the portal Shipping section's bodies and responses.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  OrderDocumentFieldsDto,
  PortalAwbAdviceDto,
  PortalClientLabelUploadFieldsDto,
  PortalOrderShippingResponse,
  PortalShipmentResponse,
  ShippingFileResponse,
} from './shipping.dto';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { ClientsFacade } from '../modules/clients/clients.facade';
import { CurrentPortalSession, PortalSessionGuard, type PortalSession } from '../modules/clients/portal-session.guard';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { InboundFacade } from '../modules/inbound/inbound.facade';
import { BillingFacade } from '../modules/billing/billing.facade';
import { CatalogFacade } from '../modules/catalog/catalog.facade';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { ReportingFacade } from '../modules/reporting/reporting.facade';
import { ReturnsFacade } from '../modules/returns/returns.facade';
import { RecallsFacade } from '../modules/recalls/recalls.facade';
import { XLSX_CONTENT_TYPE } from '../modules/reporting/reporting.facade';
import { PortalRecallDetailResponse, PortalRecallListResponse } from '../modules/recalls/recall.dto';
// Bound to @Query() — value imports (the ValidationPipe reads the classes).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RecallPageQueryDto, RecallReportQueryDto } from '../modules/recalls/recall.dto';
import { finishRecallReport, recallReportSink } from './recall-report-sink';
// Bound to @Query() — a value import (the query class is read by the ValidationPipe).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PortalReturnDetailResponse, PortalReturnPageResponse, PortalReturnsQuery } from '../modules/returns/returns.dto';
import { PortalClientReturnDetailResponse, PortalClientReturnPageResponse } from './client-returns.dto';
import { ServiceReportDto, toServiceReportDto } from './reporting.dto';
// Bound to @Query() — a value import (see the portal.dto import below).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ServiceReportQuery } from './reporting.dto';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
// The query classes are bound to @Query() and read by the ValidationPipe
// through emitDecoratorMetadata — a type-only import would erase them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  PortalAsnDetailResponse,
  PortalAsnPageResponse,
  PortalAsnsQuery,
  PortalCreateAsnDto,
  PortalCreateOrderDto,
  PortalImportOrdersDto,
  PortalInvoiceDetailResponse,
  PortalInvoiceNotesResponse,
  PortalNoteDetailResponse,
  PortalInvoicePageResponse,
  PortalMeResponse,
  PortalOrderDetailResponse,
  PortalOrderImportResponseDto,
  PortalOrderPageResponse,
  PortalOrdersQuery,
  PortalPageQuery,
  PortalPlacedOrderResponse,
  PortalPurchaseOrderDetailResponse,
  PortalPurchaseOrderPageResponse,
  PortalPurchaseOrdersQuery,
  PortalSkuPageResponse,
  PortalStockPageResponse,
  PortalWarehouseListResponse,
} from './portal.dto';
import { PortalGoodsReceiptDetailDto, PortalGoodsReceiptListResponse } from '../modules/inbound/receipt-photo.dto';
// Bound to @Query() — a value import (the ValidationPipe reads the class).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GrnDocumentFileQueryDto } from '../modules/inbound/receiving.dto';

const PORTAL_401 = 'Missing, invalid or expired session token — or the user is no longer an active client-portal user of this client (unauthenticated)';
const PORTAL_403 =
  'An operator session — "This is a client-portal surface." (role-denied); the session belongs to another tenant (permission-denied); or the client is suspended (client-suspended) or has departed (client-departed, story 1-2a)';
const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];
const PORTAL_PAGE_400 = 'A malformed cursor (invalid-cursor), a limit outside 1–100 or a status outside its vocabulary (validation-failed)';

/**
 * Story 21-7 — the client portal (CAP-8): every route `/tenants/{t}/portal/…`
 * behind `PortalSessionGuard` (a portal token only, the user and client
 * re-read per request) and `assertOwnTenant`. Each read is its owning
 * module's facade method taking `(tenantId, clientId, query)` — the client
 * comes from the guard's re-read, never from the request — and never an
 * operator read route. Holds no rules.
 *
 * Story 21-7b — read-mostly plus ASN: the ONE write is
 * `POST portal/inbound/asns` (a client announces its own shipment; the
 * client is the session's, never the body's), fed by two reads for its
 * form, `portal/skus` and `portal/warehouses`.
 *
 * Story 4-1a — the second write, `POST portal/orders`: a client places an
 * outbound order for its own active SKUs (the client is the session's).
 *
 * Literal segments are declared before their `:param` siblings (the guide's
 * route-declaration-order rule).
 */
@ApiTags('portal')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class PortalController {
  constructor(
    @Inject(ClientsFacade) private readonly clients: ClientsFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(BillingFacade) private readonly billing: BillingFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(ReportingFacade) private readonly reporting: ReportingFacade,
    @Inject(ReturnsFacade) private readonly returns: ReturnsFacade,
    // Story 3-7a — only the report download's audit row (stamped).
    @Inject(RecallsFacade) private readonly recalls: RecallsFacade,
  ) {}

  @Get(':tenantId/portal/me')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in client-portal user and its client brand' })
  @ApiOkResponse({ type: PortalMeResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async me(@Param('tenantId') tenantId: string, @CurrentPortalSession() session: PortalSession): Promise<PortalMeResponse> {
    assertOwnTenant(session, tenantId);
    return this.clients.portalMe(tenantId, session.userId, session.clientId);
  }

  @Get(':tenantId/portal/stock')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "This client's stock, one row per (SKU, warehouse) where on-hand or allocated is above zero — on hand across every bin, allocated to open orders; keyset by SKU code then warehouse",
  })
  @ApiOkResponse({ type: PortalStockPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async stock(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalStockPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inventory.portalStock(tenantId, session.clientId, pageQuery(query));
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/orders')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's orders, newest first (keyset), optionally one status; story 4-1b: `reference` finds one by your order number or the channel's reference (exact)" })
  @ApiOkResponse({ type: PortalOrderPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async orders(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalOrdersQuery,
  ): Promise<PortalOrderPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.outbound.portalOrders(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.reference === undefined ? {} : { reference: query.reference }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Post(':tenantId/portal/orders')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Places an outbound order for this client's own active SKUs (orders.place; the client is the session's). Every line must be reserved in full — a shortage refuses the whole order. The result is an ordinary order the warehouse picks and ships",
  })
  @ApiBody({ type: PortalCreateOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PortalPlacedOrderResponse,
    description: 'The placed order — its id, the warehouse name, the line count and when it was placed (a matching Idempotency-Key replays it)',
  })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing (idempotency-key-required) or malformed (idempotency-key-invalid) Idempotency-Key; an invalid body — a clientId or a ratePaise, no lines or more than 200, an incomplete ship-to address, a malformed consignee GSTIN or legal name, a quantity finer than its unit, or an order number that is not 1–64 printable ASCII characters (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse(`${PORTAL_403}; or the user may not place orders for this client (role-denied)`),
  })
  @ApiResponse({
    status: 404,
    ...problemJsonResponse("The warehouse is not the tenant's, or a line's SKU is unknown, not this client's, a kit or inactive (not-found)"),
  })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'Not enough stock at the warehouse for a line — nothing was placed (order-backorder-rejected, extensions.skuCodes naming the short SKUs); a licence for one of the products is not on file with the warehouse (licence-not-covered); a SKU was deactivated while the order was placed — refused even when its stock covered the line, the portal never sells down (sku-inactive); a SKU became a kit or left this client while the order was placed (order-catalog-changed); story 4-1b: the order number is already used by another of this client\'s orders (a cancelled order frees its number) — nothing was placed (duplicate-client-order-ref); or a concurrent idempotent request (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stock reservation store is unreachable — nothing was placed (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async placeOrder(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @Body() dto: PortalCreateOrderDto,
  ): Promise<PortalPlacedOrderResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const placed = await this.outbound.placePortalOrder(
      {
        tenantId,
        // The session's client (the guard's re-read) — never the body's.
        clientId: session.clientId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup (story 10.2). The address and the consignee go
        // VERBATIM — the command owns their rules behind that lookup.
        lines: dto.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
        destination: dto.destination,
        ...(dto.consigneeGstin === undefined ? {} : { consigneeGstin: dto.consigneeGstin }),
        ...(dto.consigneeLegalName === undefined ? {} : { consigneeLegalName: dto.consigneeLegalName }),
        // Story 4-1b: VERBATIM — the command normalizes and refuses it.
        ...(dto.clientOrderRef === undefined ? {} : { clientOrderRef: dto.clientOrderRef }),
        // Story 4-2a: VERBATIM — the command normalizes and refuses them.
        ...(dto.orderType === undefined ? {} : { orderType: dto.orderType }),
        ...(dto.priority === undefined ? {} : { priority: dto.priority }),
        ...(dto.shipByDate === undefined ? {} : { shipByDate: dto.shipByDate }),
        ...(dto.codAmountPaise === undefined ? {} : { codAmountPaise: dto.codAmountPaise }),
      },
      key,
    );
    // Story 4-1b: a replay stored before 4-1b carries no `clientOrderRef` —
    // it stays absent (never invented), and a reader treats absent as null.
    return {
      orderId: placed.orderId,
      warehouseName: placed.warehouseName,
      lineCount: placed.lineCount,
      placedAt: placed.placedAt,
      ...(placed.clientOrderRef === undefined ? {} : { clientOrderRef: placed.clientOrderRef }),
      // Story 4-2a: the same rule — a replay stored before 4-2a carries none.
      ...(placed.orderType === undefined ? {} : { orderType: placed.orderType }),
      ...(placed.priority === undefined ? {} : { priority: placed.priority }),
      ...(placed.shipByDate === undefined ? {} : { shipByDate: placed.shipByDate }),
      ...(placed.codAmountPaise === undefined ? {} : { codAmountPaise: placed.codAmountPaise }),
    };
  }

  /**
   * Story 4-1c — the portal order import: this client's orders from one
   * CSV/XLSX file (no `client` or `rate` column — the client is the
   * session's). `dryRun=true` is Check file (200, nothing written, no key);
   * otherwise Import (201 when complete; 200 with `complete: false` when the
   * 15 s budget stopped it). The literal `order-imports` segment shares no
   * prefix with `orders/:orderId`.
   */
  @Post(':tenantId/portal/order-imports')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @UseFilters(SheetUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_UPLOAD_BYTES } }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      "Imports this client's orders from a CSV/XLSX file (orders.place) — one row per order line, grouped by order_ref; each order is placed exactly as Place order would (your own active SKUs, every line reserved in full or that order is refused), and an order with any bad row is refused whole. dryRun=true checks the file and writes nothing (it cannot promise stock). A run stops starting orders after 15 s (complete: false — Import again with the same file; a Check stopped so leaves the rest unchecked). ≤ 300 rows, ≤ 100 orders, ≤ 200 lines per order, ≤ 5 MB",
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'CSV or XLSX — header row required (sku, quantity, order_ref, ship_to_name, ship_to_phone, ship_to_line1, ship_to_city, ship_to_state, ship_to_pincode; optional warehouse, ship_to_line2, consignee_gstin, consignee_legal_name, order_type, priority, ship_by, cod_amount; other columns ignored)',
        },
        warehouseId: { type: 'string', format: 'uuid', description: 'The warehouse every order is placed into' },
        dryRun: { type: 'string', enum: ['true', 'false'], description: '`true`: Check file — nothing written, no Idempotency-Key needed' },
      },
      required: ['file', 'warehouseId'],
    },
  })
  @ApiHeaders([
    {
      name: 'Idempotency-Key',
      required: false,
      description: 'Client-generated ULID key — required for an import, ignored on a dry run; a retry of an unfinished import with the same file places only the orders still missing',
      schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    },
  ])
  @ApiResponse({ status: HttpStatus.CREATED, type: PortalOrderImportResponseDto, description: 'Import, complete: the placed orders and every refused row (the stored replay)' })
  @ApiResponse({ status: HttpStatus.OK, type: PortalOrderImportResponseDto, description: 'Check file (dryRun=true) — nothing written; or an Import the time budget stopped (complete: false)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key on an import, no file, a malformed warehouseId or dryRun (validation-failed), a file that cannot be read (file-unreadable), or a header without a required column (missing-columns)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(`${PORTAL_403}; or the user may not place orders for this client (role-denied)`) })
  @ApiResponse({ status: 404, ...problemJsonResponse("The warehouse is not the tenant's (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('This import is still running under the same Idempotency-Key (import-in-progress), or a concurrent import with the same key committed first (conflict)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a .csv/.xlsx file (unsupported-file-type)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('More than 5 MB, 300 data rows or 100 orders (import-too-large), or the Idempotency-Key reused with a different file or warehouse (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stock reservation store is unreachable (reservation-store-unavailable) — Import again with the same file to finish without duplicates') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async importOrders(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: PortalImportOrdersDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalOrderImportResponseDto> {
    assertOwnTenant(session, tenantId);
    const dryRun = dto.dryRun === true;
    const key = dryRun ? null : parseRequiredIdempotencyKey(idempotencyKey);
    if (!file) {
      throw new ProblemException('validation-failed', 400, 'Import file is required', 'Attach a .csv or .xlsx file in the "file" multipart field.');
    }
    const response = await this.outbound.importPortalOrders(
      {
        tenantId,
        // The session's client (the guard's re-read) — never the body's.
        clientId: session.clientId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        dryRun,
        file: { name: file.originalname, mimetype: file.mimetype, buffer: file.buffer, size: file.size },
      },
      key,
    );
    if (dryRun || !response.complete) {
      res.status(HttpStatus.OK);
    }
    // An exact key allowlist, rebuilt key by key (§7e).
    return {
      importId: response.importId,
      dryRun: response.dryRun,
      warehouseId: response.warehouseId,
      fileSha256: response.fileSha256,
      rowCount: response.rowCount,
      orderCount: response.orderCount,
      acceptedCount: response.acceptedCount,
      refusedCount: response.refusedCount,
      complete: response.complete,
      notAttemptedCount: response.notAttemptedCount,
      orders: response.orders.map((order) => ({
        orderId: order.orderId,
        clientOrderRef: order.clientOrderRef,
        lineCount: order.lineCount,
        firstRow: order.firstRow,
        replayed: order.replayed,
      })),
      errors: response.errors.map((error) => ({
        rowNumber: error.rowNumber,
        orderRef: error.orderRef,
        code: error.code,
        detail: error.detail,
        sku: error.sku,
        quantity: error.quantity,
      })),
    };
  }

  @Get(':tenantId/portal/orders/:orderId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One order of this client with its lines (kit components nested under their kit line)' })
  @ApiOkResponse({ type: PortalOrderDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed orderId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async order(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalOrderDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const order = await this.outbound.portalOrder(tenantId, session.clientId, orderId);
    if (order === null) throw notFound('Order', orderId);
    return { ...order, lines: order.lines.map((line) => ({ ...line, components: [...line.components] })) };
  }

  // ── story 4-4a: the order's Shipping section and the client's uploads ───

  @Get(':tenantId/portal/orders/:orderId/shipping')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — this order’s Shipping: the status in client words, the courier and AWB, the handover time and pickup, the label, the documents and the signed sheet (short-lived download links)' })
  @ApiOkResponse({ type: PortalOrderShippingResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed orderId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async orderShipping(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalOrderShippingResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const shipping = await this.outbound.portalOrderShipping(tenantId, session.clientId, orderId);
    if (shipping === null) throw notFound('Order', orderId);
    return JSON.parse(JSON.stringify(shipping)) as PortalOrderShippingResponse;
  }

  @Post(':tenantId/portal/orders/:orderId/shipment/client-label')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: CLIENT_LABEL_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-4a — orders.place: upload your own courier label (a PDF) with its AWB and courier for an open order; replace=true replaces your label before the handover' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        awb: { type: 'string' },
        courierName: { type: 'string' },
        packageCount: { type: 'string' },
        replace: { type: 'string', enum: ['true'] },
      },
      required: ['file', 'awb', 'courierName'],
    },
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: PortalShipmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed AWB, courier name, count, key or part (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('order-not-open, shipment-exists (naming the AWB), shipment-handed-over, awb-in-use (naming your own order)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('pdf-unreadable, pdf-too-many-pages, attachment-too-large, idempotency-key-reuse') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async uploadClientLabel(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @Body() fields: PortalClientLabelUploadFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<PortalShipmentResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.recordPortalClientLabel(
      {
        tenantId,
        clientId: session.clientId,
        actorUserId: session.userId,
        orderId,
        awb: fields.awb,
        courierName: fields.courierName,
        packageCount: parseCountField(fields.packageCount),
        replace: parseReplaceField(fields.replace),
        bytes: file?.buffer,
      },
      key,
    );
    return { shipment: { ...snapshot.shipment } };
  }

  @Post(':tenantId/portal/orders/:orderId/shipment/awb')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 4-4a — orders.place: send the AWB only (your courier brings its own label)' })
  @ApiBody({ type: PortalAwbAdviceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: PortalShipmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed AWB, courier name, count or key (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('order-not-open, shipment-exists, shipment-handed-over, awb-in-use') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async adviseAwb(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @Body() dto: PortalAwbAdviceDto,
  ): Promise<PortalShipmentResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.recordPortalAwbAdvice(
      {
        tenantId,
        clientId: session.clientId,
        actorUserId: session.userId,
        orderId,
        awb: dto.awb,
        courierName: dto.courierName,
        packageCount: dto.packageCount,
        replace: dto.replace,
      },
      key,
    );
    return { shipment: { ...snapshot.shipment } };
  }

  @Post(':tenantId/portal/orders/:orderId/documents')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @UseFilters(AttachmentUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: ATTACHMENT_UPLOAD_LIMITS }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Story 4-4a — orders.place: upload your invoice, challan, e-way bill or another document for an order (an image or a PDF; at most 10 of yours per order)' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['invoice', 'challan', 'eway-bill', 'other'] } }, required: ['file', 'kind'] } })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ShippingFileResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing file, or a kind outside invoice, challan, eway-bill, other (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('A cancelled order (order-not-open), or 10 of your documents already (document-limit)') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not an image or a PDF (attachment-type-unsupported)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('attachment-too-large, attachment-content-invalid, pdf-unreadable, pdf-too-many-pages, idempotency-key-reuse') })
  @ApiResponse({ status: 503, ...problemJsonResponse('file-storage-unavailable, file-storage-failed, file-storage-busy') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async uploadOrderDocument(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @Body() fields: OrderDocumentFieldsDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ShippingFileResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.uploadPortalOrderDocument(
      { tenantId, clientId: session.clientId, actorUserId: session.userId, orderId, kind: fields.kind, bytes: file?.buffer },
      key,
    );
    return { file: { ...snapshot.file } };
  }

  @Get(':tenantId/portal/inbound/asns')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's advance shipment notices, newest first (keyset), optionally one status" })
  @ApiOkResponse({ type: PortalAsnPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async asns(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalAsnsQuery,
  ): Promise<PortalAsnPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.portalAsns(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Post(':tenantId/portal/inbound/asns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Announces this client's inbound shipment — an advance shipment notice of its own SKUs into one of the tenant's warehouses (asn.announce; the client is the session's). The result is an ordinary ASN the warehouse receives against",
  })
  @ApiBody({ type: PortalCreateAsnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PortalAsnDetailResponse,
    description: 'The announced ASN, in the shape of GET portal/inbound/asns/{asnId} (a matching Idempotency-Key replays it)',
  })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'Missing (idempotency-key-required) or malformed (idempotency-key-invalid) Idempotency-Key; an invalid body — a clientId or a line id, no lines or more than 200, a code over 64 characters, a malformed expectedAt, or a quantity finer than its unit (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse(`${PORTAL_403}; or the user may not announce for this client (role-denied)`),
  })
  @ApiResponse({ status: 404, ...problemJsonResponse("The warehouse is not the tenant's, or a line's SKU is unknown or not this client's (not-found)") })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'A line names a kit SKU (kit-cannot-hold-stock) or an inactive SKU (sku-inactive), the client already has this code (duplicate-asn-code), or a concurrent idempotent request (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async announceAsn(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentPortalSession() session: PortalSession,
    @Body() dto: PortalCreateAsnDto,
  ): Promise<PortalAsnDetailResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const asn = await this.inbound.announceAsn(
      {
        tenantId,
        // The session's client (the guard's re-read) — never the body's.
        clientId: session.clientId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        asnCode: dto.asnCode,
        expectedAt: dto.expectedAt ?? null,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup (story 10.2).
        lines: dto.lines.map((line) => ({ skuId: line.skuId, announcedQty: line.announcedQty })),
      },
      key,
    );
    return { ...asn, lines: asn.lines.map((line) => ({ ...line })) };
  }

  @Get(':tenantId/portal/inbound/asns/:asnId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One advance shipment notice of this client with its lines' })
  @ApiOkResponse({ type: PortalAsnDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed asnId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such ASN of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async asn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalAsnDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(asnId, 'asnId');
    const asn = await this.inbound.portalAsn(tenantId, session.clientId, asnId);
    if (asn === null) throw notFound('Advance shipment notice', asnId);
    return { ...asn, lines: [...asn.lines] };
  }

  // ── story 2-5a: the client's goods receipts (A4 — the minimal read 2.9 extends) ──

  @Get(':tenantId/portal/inbound/goods-receipts')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Story 2-5a — this client's goods receipts, newest first (keyset): what arrived, what was damaged or short, and how many damage photos" })
  @ApiOkResponse({ type: PortalGoodsReceiptListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async goodsReceipts(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalGoodsReceiptListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.portalGoodsReceipts(tenantId, session.clientId, pageQuery(query));
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/inbound/goods-receipts/:grnId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 2-5a — one of this client's goods receipts with its lines and their damage photos (short-lived presigned URLs); a photo the warehouse removed is a placeholder with no image",
  })
  @ApiOkResponse({ type: PortalGoodsReceiptDetailDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed grnId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such goods receipt of this client — unknown, another client's, or unattributed (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'grnId', format: 'uuid' })
  async goodsReceipt(
    @Param('tenantId') tenantId: string,
    @Param('grnId') grnId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalGoodsReceiptDetailDto> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(grnId, 'grnId');
    const grn = await this.inbound.portalGoodsReceipt(tenantId, session.clientId, grnId);
    if (grn === null) throw notFound('Goods receipt', grnId);
    return { ...grn, lines: grn.lines.map((line) => ({ ...line, photos: line.photos.map((photo) => ({ ...photo })) })) };
  }

  @Get(':tenantId/portal/inbound/goods-receipts/:grnId/document/file')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 2-9a — one of this client's goods receipts as its GRN document: the A4 PDF (`format=pdf`, the same document the warehouse holds) or its lines as CSV (`format=csv`). Names `{GRN code}.pdf` / `{GRN code}-lines.csv`",
  })
  @ApiProduces('application/pdf', 'text/csv')
  @ApiResponse({
    status: 200,
    description: 'The file',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'text/csv': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('format absent or not pdf|csv, or a malformed grnId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such goods receipt of this client — unknown, another client's, or unattributed (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'grnId', format: 'uuid' })
  async goodsReceiptFile(
    @Param('tenantId') tenantId: string,
    @Param('grnId') grnId: string,
    @Query() query: GrnDocumentFileQueryDto,
    @CurrentPortalSession() session: PortalSession,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(grnId, 'grnId');
    const file = await this.inbound.portalGoodsReceiptFile(tenantId, session.clientId, grnId, query.format);
    if (file === null) throw notFound('Goods receipt', grnId);
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.body);
  }

  @Get(':tenantId/portal/inbound/purchase-orders')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's purchase orders, newest first (keyset), optionally one status" })
  @ApiOkResponse({ type: PortalPurchaseOrderPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async purchaseOrders(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPurchaseOrdersQuery,
  ): Promise<PortalPurchaseOrderPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.portalPurchaseOrders(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/inbound/purchase-orders/:poId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One purchase order of this client with its lines' })
  @ApiOkResponse({ type: PortalPurchaseOrderDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed poId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such purchase order of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'poId', format: 'uuid' })
  async purchaseOrder(
    @Param('tenantId') tenantId: string,
    @Param('poId') poId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalPurchaseOrderDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(poId, 'poId');
    const po = await this.inbound.portalPurchaseOrder(tenantId, session.clientId, poId);
    if (po === null) throw notFound('Purchase order', poId);
    return { ...po, lines: [...po.lines] };
  }

  @Get(':tenantId/portal/skus')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "This client's SKUs — every one but kits (a kit cannot be received) — the announce form's options; keyset by code",
  })
  @ApiOkResponse({ type: PortalSkuPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed cursor (invalid-cursor) or a limit outside 1–100 (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async skus(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalSkuPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.catalog.portalSkus(tenantId, session.clientId, pageQuery(query));
    return { items: page.items.map((row) => ({ ...row })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/warehouses')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The tenant's warehouses a client may announce a shipment into — name and city only, by name; unpaginated (capped at 200)",
  })
  @ApiOkResponse({ type: PortalWarehouseListResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async warehouses(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalWarehouseListResponse> {
    assertOwnTenant(session, tenantId);
    return { items: await this.tenancy.portalWarehouses(tenantId, session.clientId) };
  }

  /**
   * Story 21-8 — this client's service report (CAP-10): the SAME facade read
   * as the operator's `GET reporting/clients/{c}/service`, for the session's
   * own client — so both sides see identical figures. A query `clientId` is
   * not a member of the query class (`forbidNonWhitelisted` → 400).
   */
  @Get(':tenantId/portal/service')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "This client's service report over an inclusive IST date period — dock-to-stock, pick accuracy and dispatch timeliness (24 h target); identical to the operator's report for this client",
  })
  @ApiOkResponse({ type: ServiceReportDto })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'A from/to that is not a real YYYY-MM-DD date, from after to, a period longer than 366 days, a malformed warehouseId, or any other query parameter — a clientId included (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such warehouse in this tenant (not-found)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The report did not finish within its 5 s budget — try a shorter period (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async service(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: ServiceReportQuery,
  ): Promise<ServiceReportDto> {
    assertOwnTenant(session, tenantId);
    return toServiceReportDto(
      await this.reporting.portalServiceReport(tenantId, session.clientId, {
        from: query.from,
        to: query.to,
        warehouseId: query.warehouseId ?? null,
      }),
    );
  }

  /**
   * Story 4-7a — this client's returns with what happened to the goods
   * (decision 11): read only, the RMA list and detail, an exact allowlist —
   * totals per outcome, reasons and times; never a bin, user, note or hold id.
   */
  @Get(':tenantId/portal/returns')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 4-7a — this client's return authorizations, newest first (keyset), each with received / restocked / on hold / failed inspection / scrapped / still open totals; optionally only those still awaiting a disposition or fully dispositioned",
  })
  @ApiOkResponse({ type: PortalReturnPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async portalReturns(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalReturnsQuery,
  ): Promise<PortalReturnPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.returns.portalReturns(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.dispositionState === undefined ? {} : { dispositionState: query.dispositionState }),
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/returns/:rmaId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 4-7a — one of this client\'s returns: per line authorized, received, restocked, on hold, failed inspection, scrapped and open, with the return reason; and every disposition (outcome, quantity, reason, time), oldest first',
  })
  @ApiOkResponse({ type: PortalReturnDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed rmaId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such return of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rmaId', format: 'uuid' })
  async portalReturn(
    @Param('tenantId') tenantId: string,
    @Param('rmaId') rmaId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalReturnDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rmaId, 'rmaId');
    const rma = await this.returns.portalReturn(tenantId, session.clientId, rmaId);
    if (rma === null) throw notFound('Return', rmaId);
    return {
      ...rma,
      lines: rma.lines.map((line) => ({ ...line })),
      dispositions: rma.dispositions.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Story 4-7c (decision 15) — the client's returns to client ("Shipments
   * back to you"): read only, the list and detail, an exact allowlist —
   * status, carrier, AWB, packages and lines; never a user, device, bin,
   * note or cancel reason. No portal print, no portal write.
   */
  @Get(':tenantId/portal/client-returns')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Story 4-7c — this client's returns to client (shipments of its returned and damaged goods back to it), newest first (keyset), each with status, carrier, AWB and packages",
  })
  @ApiOkResponse({ type: PortalClientReturnPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async portalClientReturns(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalClientReturnPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.returns.portalClientReturns(tenantId, session.clientId, pageQuery(query));
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/client-returns/:clientReturnId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Story 4-7c — one of this client's returns to client: status, the address it goes to, the brand document, carrier, AWB, packages and every line (what was sent and what left)",
  })
  @ApiOkResponse({ type: PortalClientReturnDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed clientReturnId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such return to client of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientReturnId', format: 'uuid' })
  async portalClientReturn(
    @Param('tenantId') tenantId: string,
    @Param('clientReturnId') clientReturnId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalClientReturnDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(clientReturnId, 'clientReturnId');
    const rtc = await this.returns.portalClientReturn(tenantId, session.clientId, clientReturnId);
    if (rtc === null) throw notFound('Return to client', clientReturnId);
    return {
      ...rtc,
      consigneeAddress: { ...rtc.consigneeAddress },
      brandDocument: rtc.brandDocument === null ? null : { ...rtc.brandDocument },
      lines: rtc.lines.map((line) => ({ ...line })),
    };
  }

  // ── story 3-7a: the client's batch recalls (A11) ──────────────────────────
  // Read only: the list, one recall (lots, figures, per-warehouse on hand —
  // never a bin, never another client's order, never an actor) and its
  // report. A recall is visible the moment it commits; a suspended or
  // departed client is refused by the guard before any header.

  @Get(':tenantId/portal/recalls')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Story 3-7a — this client's batch recalls (a live recall blocks the lots; a mock one is a drill), newest first (keyset)" })
  @ApiOkResponse({ type: PortalRecallListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed cursor (invalid-cursor) or a limit outside 1–100 (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async portalRecalls(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: RecallPageQueryDto,
  ): Promise<PortalRecallListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.reporting.portalRecalls(tenantId, session.clientId, {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/recalls/:recallId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — one of this client's recalls: the reason and reference, every lot with its live figures (and those frozen at close), on hand per warehouse and location role, and its own open orders holding a lot",
  })
  @ApiOkResponse({ type: PortalRecallDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such recall of this client — unknown, or another client's (not-found)") })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async portalRecall(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalRecallDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    return JSON.parse(JSON.stringify(await this.reporting.portalRecall(tenantId, session.clientId, recallId))) as PortalRecallDetailResponse;
  }

  @Get(':tenantId/portal/recalls/:recallId/report')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — one of this client's recall reports as a FILE (the staff report's rows less the warehouse's planned picks): CSV streams every row and ends in a `section=end` row carrying the count; XLSX at most 200,000 rows. Every download is audited",
  })
  @ApiProduces('text/csv', XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'The file', content: { 'text/csv': { schema: { type: 'string', format: 'binary' } }, [XLSX_CONTENT_TYPE]: { schema: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId, or a format outside csv | xlsx (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such recall of this client — unknown, or another client's (not-found)") })
  @ApiResponse({ status: 422, ...problemJsonResponse('The XLSX would pass 200,000 rows — download the CSV (report-too-large)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('A recall report is already being prepared, or the read did not finish within its budget (report-unavailable; Retry-After: 5)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async portalRecallReport(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: RecallReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    await finishRecallReport(res, () =>
      this.reporting.portalRecallReport(
        tenantId,
        session.clientId,
        recallId,
        query.format,
        recallReportSink(res, (rowCount) =>
          this.recalls.portalRecordReportDownload(tenantId, session.clientId, session.userId, recallId, query.format, rowCount),
        ),
      ),
    );
  }

  @Get(':tenantId/portal/invoices')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's issued invoices (never a draft), newest first (keyset) — the invoice and its lines only" })
  @ApiOkResponse({ type: PortalInvoicePageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed cursor (invalid-cursor) or a limit outside 1–100 (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async invoices(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalInvoicePageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.billing.portalInvoices(tenantId, session.clientId, pageQuery(query));
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/invoices/:invoiceId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One issued invoice of this client: the frozen party and its lines (no drill-down, no rate card)' })
  @ApiOkResponse({ type: PortalInvoiceDetailResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such invoice of this client — unknown, malformed, a draft, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async invoice(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalInvoiceDetailResponse> {
    assertOwnTenant(session, tenantId);
    // The operator route's convention (21-5): a malformed invoice id is the
    // same 404 as an unknown one.
    if (!UUID_RE.test(invoiceId)) throw notFound('Client invoice', invoiceId);
    const invoice = await this.billing.portalInvoice(tenantId, session.clientId, invoiceId);
    if (invoice === null) throw notFound('Client invoice', invoiceId);
    return { ...invoice, lines: [...invoice.lines] };
  }

  @Get(':tenantId/portal/invoices/:invoiceId/notes')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Story 5-6a — the issued and void credit and debit notes of one of this client's invoices, and the document value after the issued ones" })
  @ApiOkResponse({ type: PortalInvoiceNotesResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such invoice of this client — unknown, malformed, a draft, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async invoiceNotes(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalInvoiceNotesResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(invoiceId)) throw notFound('Client invoice', invoiceId);
    const notes = await this.billing.portalInvoiceNotes(tenantId, session.clientId, invoiceId);
    if (notes === null) throw notFound('Client invoice', invoiceId);
    return { notes: notes.notes.map((note) => ({ ...note, totals: { ...note.totals } })), netDocument: { ...notes.netDocument }, netDocumentPayable: notes.netDocumentPayable };
  }

  @Get(':tenantId/portal/invoice-notes/:noteId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 5-6a — one issued or void credit or debit note of this client: the frozen party, the original invoice and the lines' })
  @ApiOkResponse({ type: PortalNoteDetailResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such note of this client — unknown, malformed, a draft, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'noteId', format: 'uuid' })
  async invoiceNote(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalNoteDetailResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(noteId)) throw notFound('Credit or debit note', noteId);
    const note = await this.billing.portalInvoiceNote(tenantId, session.clientId, noteId);
    if (note === null) throw notFound('Credit or debit note', noteId);
    return { ...note, totals: { ...note.totals }, lines: note.lines.map((line) => ({ ...line })) };
  }
}

function pageQuery(query: PortalPageQuery): { cursor?: string; limit?: number } {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function assertOwnTenant(session: PortalSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}

function assertUuidParam(value: string, name: 'orderId' | 'asnId' | 'poId' | 'grnId' | 'rmaId' | 'recallId' | 'clientReturnId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}

function notFound(subject: string, id: string): ProblemException {
  return new ProblemException('not-found', 404, `${subject} not found`, `No ${subject.toLowerCase()} with id "${id}" exists for this client.`);
}
