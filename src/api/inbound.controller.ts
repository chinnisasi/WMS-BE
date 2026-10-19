import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Pulls in @types/multer's `Express.Multer.File` namespace augmentation.
import type {} from 'multer';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MAX_SHEET_UPLOAD_BYTES } from '../shared/import/sheet-reader';
import { SheetUploadFilter } from '../shared/import/upload-filter';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { InboundFacade } from '../modules/inbound/inbound.facade';
import type { ListPurchaseOrdersQuery } from '../modules/inbound/inbound.facade';
import type { AsnDetail } from '../modules/inbound/asn.command';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AmendAsnDto,
  AmendPurchaseOrderDto,
  AsnListQuery,
  AsnListResponse,
  AsnNoteDto,
  AsnImportResponseDto,
  AsnResponse,
  CreateAsnDto,
  ImportAsnsDto,
  ClosePurchaseOrderDto,
  CreatePurchaseOrderDto,
  PurchaseOrderCloseResponse,
  PurchaseOrderListQuery,
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
} from '../modules/inbound/inbound.dto';

const ASN_WRITE_403 =
  'Session belongs to another tenant (permission-denied), the caller lacks asn.manage (role-denied), or a client-portal session (role-denied — 21-7 opens the portal)';
const ASN_READ_403 =
  'Session belongs to another tenant (permission-denied), or a client-portal session — a user with a client (role-denied): 21-7 opens the portal';

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
 * The inbound HTTP surface (Story 3.1): the PO lifecycle (create / amend /
 * close / list / detail) — the api shell is the only HTTP surface of the
 * monolith (story 1-3 moved vendors to `partners.controller.ts`; there is no
 * `/vendors` alias), and every PO
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
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, a line\'s SKU, or the vendor does not exist in this tenant (not-found — the SKU\'s 404 wins over the vendor\'s)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('PO code already in use (conflict, naming the code); lines spanning clients (mixed-client); a departed client (client-departed); a partner without the vendor role (partner-not-vendor), an inactive vendor (vendor-inactive), or a vendor with no active link to the PO\'s client (vendor-not-linked, naming the client); or a concurrent idempotent request (conflict)') })
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
          // Story 10.2: BASE units cross this edge; the PO command scales
          // them behind its replay lookup, with each line's unit in hand.
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
  @ApiResponse({ status: 409, ...problemJsonResponse('The PO is not open (po-not-open, naming the status), a line that has received stock would be removed, change SKU or order less than it received (po-line-received), or a concurrent idempotent request (conflict)') })
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
          // Story 10.2: BASE units cross this edge; the PO command scales
          // them behind its replay lookup, with each line's unit in hand.
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
  @ApiResponse({ status: 409, ...problemJsonResponse('The PO is already closed (po-not-open, naming the status), an over-receipt of it awaits a decision (over-receipt-pending), or a concurrent idempotent request (conflict)') })
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

  // ── story 21-6: advance shipment notices ──────────────────────────────────

  @Post(':tenantId/inbound/asns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Announces an inbound shipment — an advance shipment notice (asn.manage): one client's SKUs, one warehouse, code unique per client; receiving books against it exactly as against a PO",
  })
  @ApiBody({ type: CreateAsnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: AsnResponse, description: 'The ASN, announced (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a malformed expectedAt, or a quantity finer than its unit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("The warehouse, the client, or a line's SKU does not exist in this tenant (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse("The lines span clients (mixed-client), their client is not clientId (sku-client-mismatch), a line names a kit SKU, which can never be received (kit-cannot-hold-stock, naming it), the client already has this code (duplicate-asn-code), or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createAsn(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateAsnDto,
  ): Promise<AsnResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.createAsn(
      {
        tenantId,
        actorUserId: session.userId,
        clientId: dto.clientId,
        warehouseId: dto.warehouseId,
        asnCode: dto.asnCode,
        expectedAt: dto.expectedAt ?? null,
        // BASE units cross this edge; the command scales them behind its
        // replay lookup (story 10.2).
        lines: dto.lines.map((line) => ({ skuId: line.skuId, announcedQty: line.announcedQty })),
      },
      key,
    );
    return { asn: toAsnDto(snapshot.asn) };
  }

  /**
   * The ASN import (2026-10-17): many ASNs from one CSV/XLSX file, one row
   * per ASN line. `dryRun=true` is Check file (200, nothing written, no key);
   * otherwise Import (201, one Idempotency-Key per import). The literal
   * `asn-imports` segment shares no prefix with `asns/:asnId`.
   */
  @Post(':tenantId/inbound/asn-imports')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(SheetUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_UPLOAD_BYTES } }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Imports advance shipment notices from a CSV/XLSX file (asn.manage) — one row per ASN line (asn_code, client, warehouse, expected_at, sku, quantity), grouped by client + asn_code. dryRun=true checks the file and writes nothing; otherwise every valid ASN is created exactly as the announce form would, and an ASN with any bad row is refused whole (≤ 5,000 rows, ≤ 500 ASNs, ≤ 5 MB)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CSV or XLSX — header row required (asn_code, sku, quantity; optional client, warehouse, expected_at; other columns ignored)',
        },
        warehouseId: { type: 'string', format: 'uuid', description: 'The warehouse every ASN is announced into' },
        dryRun: { type: 'string', enum: ['true', 'false'], description: '`true`: Check file — nothing written, no Idempotency-Key needed' },
      },
      required: ['file', 'warehouseId'],
    },
  })
  @ApiHeaders([
    {
      name: 'Idempotency-Key',
      required: false,
      description: 'Client-generated ULID key — required for an import, ignored on a dry run; a replay returns the original response',
      schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    },
  ])
  @ApiResponse({ status: HttpStatus.CREATED, type: AsnImportResponseDto, description: 'Import: the created ASNs and every refused row (a 201 can carry refusals) — the idempotency snapshot' })
  @ApiResponse({ status: HttpStatus.OK, type: AsnImportResponseDto, description: 'Check file (dryRun=true): what would be created and every refused row — nothing written' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key on an import, no file, a malformed warehouseId or dryRun (validation-failed), a file that cannot be read (file-unreadable), or a header without asn_code, sku or quantity (missing-columns, naming each)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent import with the same Idempotency-Key (conflict) — retry to read the settled result') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a .csv/.xlsx file (unsupported-file-type)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('More than 5 MB, 5,000 data rows or 500 ASNs (import-too-large), or the Idempotency-Key reused with a different file or warehouse (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async importAsns(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportAsnsDto,
    // Check file answers 200 (nothing created), an import 201.
    @Res({ passthrough: true }) res: Response,
  ): Promise<AsnImportResponseDto> {
    assertOwnTenant(session, tenantId);
    const dryRun = dto.dryRun === true;
    // A dry run takes no key: it writes nothing and replays nothing.
    const key = dryRun ? null : parseRequiredIdempotencyKey(idempotencyKey);
    if (!file) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Import file is required',
        'Attach a .csv or .xlsx file in the "file" multipart field.',
      );
    }
    const response = await this.inbound.importAsns(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        dryRun,
        file: { name: file.originalname, mimetype: file.mimetype, buffer: file.buffer, size: file.size },
      },
      key,
    );
    if (dryRun) {
      res.status(HttpStatus.OK);
    }
    return {
      ...response,
      asns: response.asns.map((asn) => ({ ...asn })),
      errors: response.errors.map((error) => ({ ...error })),
    };
  }

  @Get(':tenantId/warehouses/:warehouseId/inbound/asns')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists one warehouse's advance shipment notices, newest first (keyset on createdAt, id), optionally one status's or one client's — with line counts and announced / received totals",
  })
  @ApiOkResponse({ type: AsnListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId, status or clientId, a limit outside 1–100 (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listAsns(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: AsnListQuery,
  ): Promise<AsnListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const page = await this.inbound.listAsns(tenantId, session.userId, warehouseId, {
      status: query.status,
      clientId: query.clientId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/inbound/asns/:asnId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One advance shipment notice with its lines — announced / received / open per line' })
  @ApiOkResponse({ type: AsnResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed asnId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No advance shipment notice with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async getAsn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<AsnResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(asnId, 'asnId');
    const asn = await this.inbound.getAsn(tenantId, session.userId, asnId);
    if (asn === null) {
      throw new ProblemException(
        'not-found',
        404,
        'Advance shipment notice not found',
        `No advance shipment notice with id "${asnId}" exists in this tenant.`,
      );
    }
    return { asn: toAsnDto(asn) };
  }

  @Patch(':tenantId/inbound/asns/:asnId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Amends an announced or partially received ASN (asn.manage) — expectedAt and the full line set: update by id, add without id, remove by absence',
  })
  @ApiBody({ type: AmendAsnDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AsnResponse, description: 'The amended ASN — its status re-derived from the lines (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a repeated line id, a malformed expectedAt, or a quantity finer than its unit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("The ASN, a referenced line id, or a line's SKU does not exist in this tenant (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse("The ASN is received, closed or cancelled (asn-not-open), a line that has received stock would be removed, change SKU or announce less than it received (asn-line-received), a SKU of another client (sku-client-mismatch), a line names a kit SKU (kit-cannot-hold-stock, naming it), or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async amendAsn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AmendAsnDto,
  ): Promise<AsnResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(asnId, 'asnId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.amendAsn(
      {
        tenantId,
        actorUserId: session.userId,
        asnId,
        ...(dto.expectedAt === undefined ? {} : { expectedAt: dto.expectedAt }),
        lines: dto.lines.map((line) => ({
          ...(line.id === undefined ? {} : { id: line.id }),
          skuId: line.skuId,
          announcedQty: line.announcedQty,
        })),
      },
      key,
    );
    return { asn: toAsnDto(snapshot.asn) };
  }

  @Post(':tenantId/inbound/asns/:asnId/close')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Closes a partially received ASN short (asn.manage) — terminal, with a note; it leaves the open list and the device snapshot, and nothing carries forward',
  })
  @ApiBody({ type: AsnNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AsnResponse, description: 'The closed ASN (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed asnId, or a note that is blank or over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No advance shipment notice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The ASN is not partially received (asn-transition-invalid), an over-receipt of it awaits a decision (over-receipt-pending), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async closeAsn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AsnNoteDto,
  ): Promise<AsnResponse> {
    return this.transitionAsn(tenantId, asnId, idempotencyKey, session, dto, 'close');
  }

  @Post(':tenantId/inbound/asns/:asnId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancels an ASN nothing was received against (asn.manage) — terminal, with a note',
  })
  @ApiBody({ type: AsnNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AsnResponse, description: 'The cancelled ASN (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed asnId, or a note that is blank or over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(ASN_WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No advance shipment notice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The ASN is not announced — something was received, so close it short instead (asn-transition-invalid), goods receipts reference it (asn-has-receipts), an over-receipt of it awaits a decision (over-receipt-pending), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async cancelAsn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AsnNoteDto,
  ): Promise<AsnResponse> {
    return this.transitionAsn(tenantId, asnId, idempotencyKey, session, dto, 'cancel');
  }

  private async transitionAsn(
    tenantId: string,
    asnId: string,
    idempotencyKey: string | undefined,
    session: TenantSession,
    dto: AsnNoteDto,
    transition: 'close' | 'cancel',
  ): Promise<AsnResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(asnId, 'asnId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inbound.transitionAsn(
      { tenantId, actorUserId: session.userId, asnId, transition, note: dto.note },
      key,
    );
    return { asn: toAsnDto(snapshot.asn) };
  }
}

/** Inbound uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'poId' | 'warehouseId' | 'asnId'): void {
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

/** A fresh object per response (the shell never hands out the snapshot itself). */
function toAsnDto(asn: AsnDetail): AsnResponse['asn'] {
  return { ...asn, lines: asn.lines.map((line) => ({ ...line })) };
}
