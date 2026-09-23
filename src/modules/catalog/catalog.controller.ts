import { Body, Catch, Controller, Get, HttpCode, HttpStatus, Param, Patch, PayloadTooLargeException, Post, Put, Query, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Pulls in @types/multer's `Express.Multer.File` namespace augmentation.
import type {} from 'multer';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
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
import { SkuCommand } from './sku.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ProductCommand } from './product.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { KitCommand } from './kit.command';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportCatalogDto } from './catalog.dto';
import {
  CatalogImportResponse,
  CreateProductDto,
  KitListResponse,
  KitResponse,
  PatchProductDto,
  PatchSkuDto,
  ProductListResponse,
  ProductResponse,
  PutKitDto,
  SkuListResponse,
  SkuResponse,
} from './catalog.dto';

export class SkuListQuery {
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
}

export class ProductListQuery {
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

// Story 11.4 — the kit list query (the sku/product list shape, no filters yet).
export class KitListQuery {
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
 * Multer's own middleware errors never reach this filter as MulterError —
 * platform-express' FileInterceptor transforms LIMIT_FILE_SIZE into a plain
 * 413 PayloadTooLargeException first. This route-scoped filter intercepts
 * that shape and translates it: an oversized upload surfaces as 422
 * `import-too-large` problem-details, not a bare 413. Anything else is
 * rethrown for the global problem-details filter.
 */
@Catch(PayloadTooLargeException)
export class CatalogUploadFilter implements ExceptionFilter {
  // The 413's own body is multer's internal message — the translated problem
  // details carry the documented cap wording instead.
  catch(): void {
    throw new ProblemException(
      'import-too-large',
      422,
      'Import exceeds the row or size cap',
      `The file exceeds the ${MAX_IMPORT_BYTES}-byte (${MAX_IMPORT_BYTES / (1024 * 1024)} MB) cap.`,
    );
  }
}

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
  ) {}

  @Post(':tenantId/catalog/imports')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @UseFilters(CatalogUploadFilter)
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
      },
      required: ['file'],
    },
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: CatalogImportResponse, description: 'Partial commit: counts + row-level errors (a 201 can carry failures)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a file that cannot be parsed (file-unreadable)') })
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
    );
    return {
      items: page.items.map((item) => ({ ...item, uomConversions: item.uomConversions.map((c) => ({ ...c })) })),
      nextCursor: page.nextCursor,
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
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid name/axes (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks sku.edit (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Product name already exists in this tenant (duplicate-product-name)') })
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
  @ApiResponse({ status: 404, ...problemJsonResponse('Product does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Axes change with variants attached (product-has-variants), or the new name is taken (duplicate-product-name)') })
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
  @ApiResponse({ status: 409, ...problemJsonResponse('Barcode already belongs to another SKU (duplicate-barcode names it), or another SKU of this product already carries identical variantValues (duplicate-variant-values)') })
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
      },
      key,
    );
    return { ...sku, uomConversions: sku.uomConversions.map((c) => ({ ...c })) };
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
  @ApiResponse({ status: 409, ...problemJsonResponse('The SKU is already a kit (kit-already-composed), a component appears twice (duplicate-kit-component), a component is itself a kit (kit-component-is-kit — flat BOM), or the SKU already holds stock or a live reservation — making it a kit would strand that stock (kit-sku-holds-stock)') })
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
  @ApiResponse({ status: 409, ...problemJsonResponse('A component appears twice (duplicate-kit-component), or a component is itself a kit (kit-component-is-kit — flat BOM)') })
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
    );
    return {
      items: page.items.map((item) => ({ ...item, components: item.components.map((c) => ({ ...c })) })),
      nextCursor: page.nextCursor,
    };
  }
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