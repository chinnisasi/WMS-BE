import { Body, Catch, Controller, Get, HttpCode, HttpStatus, Param, Patch, PayloadTooLargeException, Post, Query, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// Pulls in @types/multer's `Express.Multer.File` namespace augmentation.
import type {} from 'multer';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
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
import { ImportCatalogDto } from './catalog.dto';
import { CatalogImportResponse, PatchSkuDto, SkuListResponse, SkuResponse } from './catalog.dto';

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
      `The file exceeds the ${MAX_IMPORT_BYTES}-byte (5 MB) cap.`,
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
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
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
    );
    return {
      items: page.items.map((item) => ({ ...item, uomConversions: item.uomConversions.map((c) => ({ ...c })) })),
      nextCursor: page.nextCursor,
    };
  }

  @Patch(':tenantId/catalog/skus/:skuId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edits a SKU (name, GST, HSN, flags, reorder defaults, barcode — the SKU code is immutable)' })
  @ApiBody({ type: PatchSkuDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: SkuResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid/empty body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Barcode already belongs to another SKU (duplicate-barcode names it)') })
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
        skuId,
        name: dto.name,
        gstRateBps: dto.gstRate,
        hsn: dto.hsn === undefined ? undefined : dto.hsn === '' ? null : dto.hsn,
        batchTracked: dto.batchTracked,
        serialTracked: dto.serialTracked,
        reorderPoint: dto.reorderPoint,
        reorderQty: dto.reorderQty,
        barcode: dto.barcode,
      },
      key,
    );
    return { ...sku, uomConversions: sku.uomConversions.map((c) => ({ ...c })) };
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