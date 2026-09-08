import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { IMPORT_MODES, GST_RATE_BPS_MAX, INT_MAX } from './import.command';

/**
 * Trim inputs at the validation boundary so the command layer's normalized
 * values and the validator agree (same convention as tenancy.dto.ts).
 */
const Trimmed = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The import's multipart form: the file plus the optional mode. */
export class ImportCatalogDto {
  @ApiProperty({ required: false, enum: IMPORT_MODES, description: '`initial` (default) or `fix` — fix processes only the latest run\'s failed SKU codes' })
  @IsOptional()
  @Trimmed()
  @IsIn(IMPORT_MODES)
  mode?: 'initial' | 'fix';
}

export class CatalogImportErrorResponse {
  @ApiProperty({ example: 3, description: '1-based data-row index (header excluded)' })
  rowNumber!: number;

  @ApiProperty({ type: String, nullable: true, example: 'MAS-CHILI-100', description: 'Absent when the row failed shape validation before a code could be read' })
  skuCode!: string | null;

  @ApiProperty({ example: 'duplicate-sku-code', description: 'validation-failed | duplicate-sku-code | duplicate-barcode' })
  code!: string;

  @ApiProperty({ example: 'SKU code "MAS-CHILI-100" already exists in this tenant\'s catalog — duplicates are rejected, never merged.' })
  detail!: string;
}

export class CatalogImportResponse {
  @ApiProperty({ format: 'uuid' })
  importId!: string;

  @ApiProperty({ enum: IMPORT_MODES, example: 'initial' })
  mode!: string;

  @ApiProperty({ example: 4970, description: 'Rows committed in this run\'s single transaction' })
  committedRows!: number;

  @ApiProperty({ example: 30, description: 'Rows rejected with a row-level error' })
  failedRows!: number;

  @ApiProperty({ example: 0, description: 'Rows skipped by fix mode (not in the latest run\'s failed set)' })
  skippedRows!: number;

  @ApiProperty({ type: [CatalogImportErrorResponse] })
  errors!: CatalogImportErrorResponse[];
}

export class SkuUomConversionResponse {
  @ApiProperty({ example: 'box' })
  uom!: string;

  @ApiProperty({ example: 12, description: 'Positive integer, relative to the SKU\'s base UoM' })
  factor!: number;
}

export class SkuResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'MAS-CHILI-100' })
  code!: string;

  @ApiProperty({ example: 'Chili powder 100g' })
  name!: string;

  @ApiProperty({ example: 'pcs' })
  uom!: string;

  @ApiProperty({ example: 1800, description: 'GST in basis points (1800 = 18%)' })
  gstRateBps!: number;

  @ApiProperty({ type: String, nullable: true, example: '10062020' })
  hsn!: string | null;

  @ApiProperty({ example: false })
  batchTracked!: boolean;

  @ApiProperty({ example: false })
  serialTracked!: boolean;

  @ApiProperty({ example: 50 })
  reorderPoint!: number;

  @ApiProperty({ example: 100 })
  reorderQty!: number;

  @ApiProperty({ example: '0198f7a2-1b3c-7d4e-8f90-112233445588', description: 'Generated server-side (uuidv7) unless provided' })
  barcode!: string;

  @ApiProperty({ type: [SkuUomConversionResponse] })
  uomConversions!: SkuUomConversionResponse[];

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class SkuListResponse {
  @ApiProperty({ type: [SkuResponse] })
  items!: SkuResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

/** PATCH fields (spec 1.4): SKU code is immutable; barcode is changeable. */
export class PatchSkuDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiProperty({ required: false, example: 1800, minimum: 0, maximum: GST_RATE_BPS_MAX, description: 'GST in basis points (1800 = 18%)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(GST_RATE_BPS_MAX)
  gstRate?: number;

  @ApiProperty({ required: false, type: String, nullable: true, maxLength: 32 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(0, 32)
  hsn?: string | null;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  batchTracked?: boolean;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  serialTracked?: boolean;

  @ApiProperty({ required: false, example: 50, minimum: 0, maximum: INT_MAX, description: 'Base-UoM units' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  reorderPoint?: number;

  @ApiProperty({ required: false, example: 100, minimum: 0, maximum: INT_MAX, description: 'Base-UoM units' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  reorderQty?: number;

  @ApiProperty({ required: false, minLength: 1, maxLength: 64 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(1, 64)
  barcode?: string;
}