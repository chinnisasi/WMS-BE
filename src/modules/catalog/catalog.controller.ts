import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Pulls in @types/multer's `Express.Multer.File` namespace augmentation.
import type {} from 'multer';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { SKU_STATUSES, type SkuStatus } from '../../shared/db/schema';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { UUID_RE } from '../../shared/primitives/ids';
// The ASN import story moved the upload filter to `shared` (one copy for both imports).
import { SheetUploadFilter } from '../../shared/import/upload-filter';
import { CurrentSession } from '../tenancy/tenant-session.guard';
import { TenantSessionGuard } from '../tenancy/tenant-session.guard';
import type { TenantSession } from '../tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../tenancy/idempotency-guard';
// Constructor params are types here but must stay value imports: Nest DI needs
// the runtime class tokens for decorator metadata (same bend as the tenancy
// controller).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportCommand, MAX_IMPORT_BYTES } from './import.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SkuCommand, type SkuSnapshot } from './sku.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ProductCommand } from './product.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { KitCommand } from './kit.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CatalogFacade } from './catalog.facade';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SkuClientCommand } from './sku-client.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportCatalogDto } from './catalog.dto';
import {
  CatalogImportResponse,
  CorrectSkuClientDto,
  CreateProductDto,
  CreateSkuDto,
  ReplacePackagingDto,
  SkuWriteResponse,
  SkuClientCorrectionResponse,
  KitListResponse,
  KitResponse,
  PatchProductDto,
  PatchSkuDto,
  ProductListResponse,
  ProductResponse,
  PutKitDto,
  SegregationMatrixResponse,
  SkuListResponse,
  SkuResponse,
  UpdateSkuStatusDto,
} from './catalog.dto';

export class SkuListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's SKUs. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  // Story 11.3 — the optional product filter: the variants of ONE product
  // (the 11-6 matrix's data source), same keyset sort.
  @ApiProperty({ required: false, format: 'uuid', description: 'List only the SKUs attached to this product' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  // Story 1-4b — the optional status filter. Absent lists every SKU (display
  // lookups depend on that).
  @ApiProperty({ required: false, enum: [...SKU_STATUSES], description: 'Story 1-4b — only active or only inactive SKUs; absent lists every SKU' })
  @IsOptional()
  @IsIn(SKU_STATUSES)
  status?: SkuStatus;
}

export class ProductListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's products. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// Story 11.4 — the kit list query (the sku/product list shape; story 1-5a adds the client filter).
export class KitListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's kits. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

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
 * Catalog HTTP surface (Story 1.4): the synchronous multipart CSV/XLSX import
 * with partial commit, the SKU list, and the individual SKU edit. Same
 * patterns as the tenancy controller: ValidationPipe-enforced DTOs, the
 * tenant-session guard with the path-tenant check, problem-json errors.
 */
@ApiTags('catalog')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class CatalogController {
  constructor(
    private readonly importCommand: ImportCommand,
    private readonly skuCommand: SkuCommand,
    private readonly productCommand: ProductCommand,
    private readonly kitCommand: KitCommand,
    private readonly catalogFacade: CatalogFacade,
    private readonly skuClientCommand: SkuClientCommand,
  ) {}

  @Post(':tenantId/catalog/imports')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(SheetUploadFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES } }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Imports a CSV/XLSX catalog — valid rows commit in one transaction, bad rows are listed per row (≤ 10,000 rows, ≤ 5 MB)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV or XLSX with the documented header (sku_code,name,uom,gst_rate required)' },
        mode: { type: 'string', enum: ['initial', 'fix'], description: '`initial` (default) or `fix` — fix processes only the latest run\'s failed SKU codes' },
        clientId: { type: 'string', format: 'uuid', description: 'Story 21-2b — the client the new SKUs belong to. Required (client-required) once the tenant holds more than one client; a fix-mode re-run inherits its original run\'s client' },
      },
      required: ['file'],
    },
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: CatalogImportResponse, description: 'Partial commit: counts + row-level errors (a 201 can carry failures)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a file that cannot be parsed (file-unreadable), a non-uuid clientId or a fix-mode re-run naming a different client than its original run (validation-failed), or no clientId while the tenant holds more than one client (client-required)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('clientId names no client of this tenant (not-found)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks catalog.import (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent import with the same Idempotency-Key (conflict), or the SKU/barcode this file introduces was committed by a concurrent import and a row-level check raced it (duplicate-sku-code / duplicate-barcode) — regenerate the key or retry') })
  @ApiResponse({ status: 415, ...problemJsonResponse('Not a .csv/.xlsx file (unsupported-file-type)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('More than 10,000 rows or 5 MB (import-too-large), or idempotency-key-reuse') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async importCatalog(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportCatalogDto,
  ): Promise<CatalogImportResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    if (!file) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Import file is required',
        'Attach a .csv or .xlsx file in the "file" multipart field.',
      );
    }
    const snapshot = await this.importCommand.execute(
      {
        tenantId,
        actorUserId: session.userId,
        file: { name: file.originalname, mimetype: file.mimetype, buffer: file.buffer, size: file.size },
        mode: parseMode(dto.mode),
        // Story 21-2b — uuid-checked by the DTO (400); existence is the
        // command's 404, behind the replay lookup.
        clientId: dto.clientId,
      },
      key,
    );
    return { ...snapshot, errors: snapshot.errors.map((error) => ({ ...error })) };
  }

  @Get(':tenantId/catalog/skus')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists SKUs (keyset cursor pagination)' })
  @ApiOkResponse({ type: SkuListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listSkus(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: SkuListQuery,
  ): Promise<SkuListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.skuCommand.list(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
      query.productId,
      { clientId: query.clientId, status: query.status },
    );
    return {
      items: page.items.map(toSkuResponse),
      nextCursor: page.nextCursor,
    };
  }

  // ── Story 1-4 — the single-SKU create and the packaging PUT ───────────────

  @Post(':tenantId/catalog/skus')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates one SKU — one import row\'s worth of typed fields, its pack levels and barcodes included, in one keyed transaction',
  })
  @ApiBody({ type: CreateSkuDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: SkuWriteResponse, description: 'The created SKU (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key; an invalid field — unknown uom, GST, attributes, classes, shelf life, a level equal to the base uom or repeated, a factor outside 2–1,000,000, a barcode breaking the rule or equal to the primary (validation-failed); a barcode on a level the SKU does not declare (barcode-level-unknown); no clientId while the tenant holds more than one client (client-required)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('clientId names no client of this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The code is taken in the client (duplicate-sku-code); a barcode is taken in the client or listed twice (duplicate-barcode, naming the holder and its level); a barcode equals a SKU code of the client, or the code equals a barcode (barcode-is-code); the client has departed (client-departed); a concurrent same-key request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createSku(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateSkuDto,
  ): Promise<SkuWriteResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const created = await this.skuCommand.create(
      {
        tenantId,
        actorUserId: session.userId,
        code: dto.code,
        name: dto.name,
        uom: dto.uom,
        gstRateBps: dto.gstRate,
        hsn: dto.hsnCode,
        barcode: dto.barcode,
        batchTracked: dto.batchTracked,
        serialTracked: dto.serialTracked,
        catchWeightTracked: dto.catchWeightTracked,
        weightGrams: dto.attributes?.weightGrams,
        lengthMm: dto.attributes?.lengthMm,
        widthMm: dto.attributes?.widthMm,
        heightMm: dto.attributes?.heightMm,
        countryOfOrigin: dto.attributes?.countryOfOrigin,
        storageClass: dto.storageClass,
        hazardClass: dto.hazardClass,
        abcClass: dto.abcClass,
        // Base units — converted inside the command, behind the replay (10.2).
        reorderPoint: dto.reorderPoint,
        reorderQty: dto.reorderQty,
        shelfLifeDays: dto.shelfLifeDays,
        clientId: dto.clientId,
        levels: dto.levels?.map((level) => ({ uom: level.uom, factor: level.factor })),
        barcodes: dto.barcodes?.map((entry) => ({ barcode: entry.barcode, uom: entry.uom })),
      },
      key,
    );
    return { sku: toSkuResponse(created.sku) };
  }

  @Put(':tenantId/catalog/skus/:skuId/packaging')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Replaces a SKU\'s pack levels (box, case, pallet — base units per level) and its non-primary barcodes, each naming its level',
  })
  @ApiBody({ type: ReplacePackagingDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: SkuWriteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key; a level repeated or equal to the base uom, a factor outside 2–1,000,000, a barcode breaking the rule or equal to the primary (validation-failed); a barcode on a level that is neither the base uom nor in levels (barcode-level-unknown)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A barcode is listed twice or held by another SKU of the client (duplicate-barcode, naming the holder and its level); a barcode equals a SKU code of the client (barcode-is-code); the SKU\'s client has departed (client-departed); a concurrent same-key request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid' })
  async replacePackaging(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ReplacePackagingDto,
  ): Promise<SkuWriteResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.skuCommand.replacePackaging(
      {
        tenantId,
        actorUserId: session.userId,
        skuId,
        levels: dto.levels.map((level) => ({ uom: level.uom, factor: level.factor })),
        barcodes: dto.barcodes.map((entry) => ({ barcode: entry.barcode, uom: entry.uom })),
      },
      key,
    );
    return { sku: toSkuResponse(result.sku) };
  }

  // Story 1-4b — deactivate / reactivate a SKU (the partners status route).
  @Patch(':tenantId/catalog/skus/:skuId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Deactivates (with an optional reason) or reactivates a SKU (sku.edit). Inactive: refused on new POs, ASNs, kits and channel mappings; orders sell down only what stock covers in full; channels publish 0; every existing document keeps it. Reactivating clears the reason. The same status is a no-op that stores the key',
  })
  @ApiBody({ type: UpdateSkuStatusDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: SkuWriteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key; an unknown status, a reason with `active`, or a reason over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent same-key request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid' })
  async updateSkuStatus(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateSkuStatusDto,
  ): Promise<SkuWriteResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.skuCommand.updateStatus(
      { tenantId, actorUserId: session.userId, skuId, status: dto.status, reason: dto.reason },
      key,
    );
    return { sku: toSkuResponse(result.sku) };
  }

  // Story 12-7 — the segregation matrix as data (FR-41, the admin view): an
  // UNGATED read (no capability, no idempotency — reads are never gated)
  // mirroring the guard pattern of `GET :tenantId/catalog/skus` above. The
  // response is the hazard vocabulary plus the FULLY EXPANDED incompatible
  // unordered-pair set enumerated from the shared primitive, so the web
  // renders `compatible(a, b) = !incompatible.includes(pair)` with zero
  // logic of its own and nothing hardcoded to drift.
  @Get(':tenantId/catalog/segregation-matrix')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Returns the hazard segregation matrix — the vocabulary plus every incompatible unordered pair, fully expanded from the server\'s own predicate',
  })
  @ApiOkResponse({ type: SegregationMatrixResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getSegregationMatrix(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<SegregationMatrixResponse> {
    assertOwnTenant(session, tenantId);
    const matrix = this.catalogFacade.getSegregationMatrix();
    return {
      classes: [...matrix.classes],
      incompatible: matrix.incompatible.map((pair) => ({ ...pair })),
    };
  }

  @Post(':tenantId/catalog/products')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a product — identity only (name + declared axes); SKUs attach to it through the SKU edit PATCH' })
  @ApiBody({ type: CreateProductDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ProductResponse, description: 'The created product (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid name/axes/clientId (validation-failed), or no clientId while the tenant holds more than one client (client-required)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('clientId names no client of this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Product name already exists for this client (duplicate-product-name), or the client has departed (client-departed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createProduct(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateProductDto,
  ): Promise<ProductResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const product = await this.productCommand.create(
      {
        tenantId,
        actorUserId: session.userId,
        name: dto.name,
        axes: dto.axes,
        clientId: dto.clientId,
      },
      key,
    );
    return { ...product, axes: [...product.axes] };
  }

  @Get(':tenantId/catalog/products')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists products (keyset cursor pagination) — items carry the derived skuCount' })
  @ApiOkResponse({ type: ProductListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listProducts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ProductListQuery,
  ): Promise<ProductListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.productCommand.list(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
      { clientId: query.clientId },
    );
    return {
      items: page.items.map((item) => ({ ...item, axes: [...item.axes] })),
      nextCursor: page.nextCursor,
    };
  }

  @Patch(':tenantId/catalog/products/:productId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edits a product (name always; axes only while no SKU is attached)' })
  @ApiBody({ type: PatchProductDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ProductResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an empty body (empty-product-edit)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Product does not exist in this tenant, or clientId names no client of this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Axes change with variants attached (product-has-variants), a client change with SKUs attached (product-has-skus), the new name is taken in the client (duplicate-product-name), or the target client has departed (client-departed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  async editProduct(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PatchProductDto,
  ): Promise<ProductResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const product = await this.productCommand.edit(
      {
        tenantId,
        actorUserId: session.userId,
        productId,
        name: dto.name,
        axes: dto.axes,
        clientId: dto.clientId,
      },
      key,
    );
    return { ...product, axes: [...product.axes] };
  }

  @Patch(':tenantId/catalog/skus/:skuId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edits a SKU (name, GST, HSN, flags, physical attributes, reorder defaults, barcode, product attach/detach — the SKU code is immutable)' })
  @ApiBody({ type: PatchSkuDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: SkuResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid/empty body, or variantValues not covering the product\'s axes (names the axis)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('SKU (or, on attach, the product) does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Barcode already belongs to another SKU (duplicate-barcode names it and its level) or equals a SKU code (barcode-is-code), another SKU of this product already carries identical variantValues (duplicate-variant-values), the product belongs to another client (product-client-mismatch), a batch/serial/catch-weight change while the SKU has stock, a pending over-receipt or a pending adjustment (sku-has-stock), or a hazard-class change would strand stock co-located with an incompatible binmate (hazard-segregation-conflict names the bins and the parties)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid' })
  async editSku(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PatchSkuDto,
  ): Promise<SkuResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // Story 12-1 (code review): the DTO's `@IsOptional` skips null as well as
    // undefined, and the edit command treats only `undefined` as absent — an
    // explicit `storageClass: null` would reach the NOT NULL column and
    // answer 500 where a 400 is the answer (the 11-5 `blocked` precedent:
    // the class has no clear verb).
    if (dto.storageClass === null) {
      throw new ProblemException(
        'validation-failed',
        400,
        'storageClass must be a string',
        'The PATCH body carries `storageClass: null` — the storage class has no clear verb (the column is NOT NULL); omit `storageClass` to leave the SKU\'s class unchanged.',
      );
    }
    const sku = await this.skuCommand.edit(
      {
        tenantId,
        actorUserId: session.userId,
        skuId,
        name: dto.name,
        gstRateBps: dto.gstRate,
        hsn: dto.hsn === undefined ? undefined : dto.hsn === '' ? null : dto.hsn,
        batchTracked: dto.batchTracked,
        serialTracked: dto.serialTracked,
        catchWeightTracked: dto.catchWeightTracked,
        // Story 11.2 — the physical attributes pass through WYSIWYG (grams /
        // millimetres); `countryOfOrigin` follows the `hsn` template, '' → null.
        weightGrams: dto.weightGrams,
        lengthMm: dto.lengthMm,
        widthMm: dto.widthMm,
        heightMm: dto.heightMm,
        countryOfOrigin:
          dto.countryOfOrigin === undefined ? undefined : dto.countryOfOrigin === '' ? null : dto.countryOfOrigin,
        // Story 10.2: both stay in BASE units here. The command converts them
        // behind its replay lookup, where the SKU's row — and therefore its
        // declared precision — is already in hand; converting at this edge
        // would have refused a too-precise value before the replay could
        // re-serve a snapshot it had already committed.
        reorderPoint: dto.reorderPoint,
        reorderQty: dto.reorderQty,
        barcode: dto.barcode,
        // Story 11.3 — the variant fields pass through WYSIWYG: absent =
        // unchanged, `productId: null` = detach (values clear with it). The
        // command is the boundary (product existence, exact axis coverage,
        // duplicate variants).
        productId: dto.productId,
        variantValues: dto.variantValues,
        // Story 12-1 — the storage class passes through WYSIWYG: absent =
        // unchanged; there is no null (the column is NOT NULL). The command
        // is the boundary (vocabulary re-check, the class-edit guard).
        storageClass: dto.storageClass,
        // Story 12-2 — the hazard class passes through WYSIWYG: absent =
        // unchanged, null = clear (the 11.2 template; the column is nullable,
        // so there is NO explicit-null 400 like `storageClass`'s). The
        // command is the boundary (vocabulary re-check, the co-location
        // guard).
        hazardClass: dto.hazardClass,
        // Story 5-3 — the ABC class passes through WYSIWYG (the hazardClass
        // twin): absent = unchanged, null = clear. The command is the
        // boundary (the vocabulary re-check).
        abcClass: dto.abcClass,
        // Story 1-4 — absent = unchanged, null = clear.
        shelfLifeDays: dto.shelfLifeDays,
      },
      key,
    );
    return toSkuResponse(sku);
  }

  // ── Story 21-2b — the owner's client correction (decision 3) ──────────────

  @Post(':tenantId/catalog/skus/:skuId/client')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Corrects a SKU's client (owner-only) — allowed only while the SKU has no ledger event, order line or PO line; after that its client never changes",
  })
  @ApiBody({ type: CorrectSkuClientDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: SkuClientCorrectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed skuId path parameter, or a non-uuid clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The SKU or the client does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The SKU, or a kit partner / product sibling that must move with it, already has history — ledger events, order/PO/transfer lines, pending adjustments, count tasks, batches, serials, reservations or channel mappings (sku-has-history, naming the SKU); a code, barcode or product name of the moving group is taken in the target client (duplicate-sku-code / duplicate-barcode / duplicate-product-name) or a barcode equals a target SKU code (barcode-is-code); or a concurrent kit/product change or same-key request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid' })
  async correctSkuClient(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CorrectSkuClientDto,
  ): Promise<SkuClientCorrectionResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(skuId)) {
      throw new ProblemException('validation-failed', 400, 'Malformed skuId', `skuId must be a uuid (got "${skuId}").`);
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const corrected = await this.skuClientCommand.correct(
      { tenantId, actorUserId: session.userId, skuId, clientId: dto.clientId },
      key,
    );
    return { skus: corrected.skus.map(toSkuResponse) };
  }

  // ── Story 11.4 — kits and bundles (FR-38, AD-19): a kit IS a SKU ──────────

  @Post(':tenantId/catalog/skus/:skuId/kit')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Makes an existing SKU a kit — attaches its flat composition (the only door into kit-ness; PUT replaces an existing kit\'s BOM)' })
  @ApiBody({ type: PutKitDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: KitResponse, description: 'The kit with its composition (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid/empty component array (empty-kit-composition, validation-failed), or the kit naming itself (kit-self-reference)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The kit SKU (or a component SKU) does not exist in this tenant (not-found / kit-component-not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The SKU is already a kit (kit-already-composed), a component appears twice (duplicate-kit-component), a component is itself a kit (kit-component-is-kit — flat BOM), or the SKU already holds stock or a live reservation — making it a kit would strand that stock (kit-sku-holds-stock); the kit or a component is inactive (sku-inactive)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid', description: 'The SKU that becomes a kit' })
  async createKit(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PutKitDto,
  ): Promise<KitResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const kit = await this.kitCommand.create(
      { tenantId, actorUserId: session.userId, skuId, components: dto.components },
      key,
    );
    return { ...kit, components: kit.components.map((c) => ({ ...c })) };
  }

  @Put(':tenantId/catalog/skus/:skuId/kit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replaces an existing kit\'s whole composition (PUT semantics — the BOM is a set, not a partial body)' })
  @ApiBody({ type: PutKitDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: KitResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid/empty component array (empty-kit-composition, validation-failed), or the kit naming itself (kit-self-reference)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The SKU does not exist — or is not a kit (replace never creates kit-ness) — or a component SKU is unknown (not-found / kit-component-not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A component appears twice (duplicate-kit-component), or a component is itself a kit (kit-component-is-kit — flat BOM); a component the stored composition did not hold is inactive (sku-inactive)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'skuId', format: 'uuid', description: 'The kit SKU whose composition is replaced' })
  async replaceKit(
    @Param('tenantId') tenantId: string,
    @Param('skuId') skuId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PutKitDto,
  ): Promise<KitResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const kit = await this.kitCommand.put(
      { tenantId, actorUserId: session.userId, skuId, components: dto.components },
      key,
    );
    return { ...kit, components: kit.components.map((c) => ({ ...c })) };
  }

  @Get(':tenantId/catalog/kits')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists kits — SKUs carrying composition rows, with their flat BOMs (keyset cursor pagination)' })
  @ApiOkResponse({ type: KitListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listKits(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: KitListQuery,
  ): Promise<KitListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.kitCommand.list(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
      { clientId: query.clientId },
    );
    return {
      items: page.items.map((item) => ({ ...item, components: item.components.map((c) => ({ ...c })) })),
      nextCursor: page.nextCursor,
    };
  }
}

/** The wire copy of a SKU snapshot — every array copied, the read-only domain shape never aliased. */
function toSkuResponse(sku: SkuSnapshot): SkuResponse {
  return {
    ...sku,
    uomConversions: sku.uomConversions.map((c) => ({ ...c })),
    barcodes: sku.barcodes.map((b) => ({ ...b })),
  };
}

function parseMode(raw: 'initial' | 'fix' | undefined): 'initial' | 'fix' {
  return raw ?? 'initial';
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