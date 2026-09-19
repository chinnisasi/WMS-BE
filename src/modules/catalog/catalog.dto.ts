import { ApiProperty } from '@nestjs/swagger';
import {
  MAX_QUANTITY_BASE,
  MIN_QUANTITY_BASE,
  QUANTITY_FIELD_DESCRIPTION,
} from '../../shared/primitives/quantity';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IMPORT_MODES, GST_RATE_BPS_MAX } from './import.command';
import { UOMS } from './uom';
import { MAX_SKU_DIMENSION_MM, MAX_SKU_WEIGHT_GRAMS } from './sku-attributes';
import { AXIS_NAME_MAX, MAX_PRODUCT_AXES, PRODUCT_NAME_MAX } from './product.command';
import { MAX_KIT_COMPONENTS } from './kit.command';

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
  // Story 10.2: the conversion target comes from the same closed vocabulary
  // the base unit does — one tuple, published as the OpenAPI enum and backed
  // by `uom_conversions_uom_check` in the database.
  @ApiProperty({ example: 'box', enum: [...UOMS] })
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

  // Story 10.2: `uom` is a CLOSED vocabulary, published as the OpenAPI enum
  // over the same tuple the DB CHECK is written from, so a generated client
  // gets a closed type rather than `string`. An import file may still SPELL a
  // unit generously (`pcs`, `Kg.`, `kilogram`); what comes back is always the
  // canonical unit it resolved to.
  @ApiProperty({ example: 'each', enum: [...UOMS] })
  uom!: string;

  // Story 10.5: the decimal places `uom` declares, derived in process from
  // the vocabulary — mirroring the device snapshot's field (10.2), so the web
  // can render at declared precision and size decimal inputs without
  // mirroring the precision table client-side. Never an input.
  @ApiProperty({
    example: 3,
    description:
      'The decimal places this SKU\'s base UoM declares (each = 0 places, kg = 3). Derived from the unit — never an input.',
  })
  uomPrecision!: number;

  @ApiProperty({ example: 1800, description: 'GST in basis points (1800 = 18%)' })
  gstRateBps!: number;

  @ApiProperty({ type: String, nullable: true, example: '10062020' })
  hsn!: string | null;

  @ApiProperty({ example: false })
  batchTracked!: boolean;

  @ApiProperty({ example: false })
  serialTracked!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Story 10.3: handled by unit, priced by weight — each physical unit received carries its own captured weight on a handling_units row. Mutually exclusive with serialTracked.',
  })
  catchWeightTracked!: boolean;

  // Story 11.2 — the static physical attributes, WYSIWYG grams/millimetres
  // (`sku-attributes.ts`). Null when unset; a pre-11.2 row reads null too.
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 500,
    description:
      'Static catalog weight in grams — what carriers rate from. Positive whole number ≤ 1,000,000 (1 tonne), or null when unset. NOT the per-handling-unit catch weight (that lives on handling_units).',
  })
  weightGrams!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 200,
    description: 'Length in millimetres. Positive whole number ≤ 10,000, or null when unset.',
  })
  lengthMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 150,
    description: 'Width in millimetres. Positive whole number ≤ 10,000, or null when unset.',
  })
  widthMm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 100,
    description: 'Height in millimetres. Positive whole number ≤ 10,000, or null when unset.',
  })
  heightMm!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'IN',
    description: 'Country of origin, ISO 3166-1 alpha-2 uppercase (e.g. IN, CN), or null when unset.',
  })
  countryOfOrigin!: string | null;

  @ApiProperty({ example: 50 })
  reorderPoint!: number;

  @ApiProperty({ example: 100 })
  reorderQty!: number;

  // Story 11.3 — the variant identity. Null on every unattached SKU (all
  // pre-11.3 rows read this way); attach/detach happens through the PATCH
  // below, never through a separate write path.
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The product this SKU is a variant of, or null when unattached.',
  })
  productId!: string | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    example: { size: 'M', colour: 'Red' },
    description: 'This SKU\'s values on the product\'s declared axes, present iff productId is set.',
  })
  variantValues!: Record<string, string> | null;

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

  @ApiProperty({
    required: false,
    example: false,
    description:
      'Story 10.3: handled by unit, priced by weight. Turning it on for a serial-tracked SKU (or the reverse) is a 400 — two per-unit identity systems over one unit is unsupported.',
  })
  @IsOptional()
  @IsBoolean()
  catchWeightTracked?: boolean;

  // Story 11.2 — the physical attributes, mirrored from `assertSkuAttributes`
  // (`sku-attributes.ts`). PATCH semantics follow the `hsn` precedent: absent
  // = unchanged, null = cleared (`@IsOptional` lets a null through
  // unvalidated; the command clears on it).
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    example: 500,
    minimum: 1,
    maximum: MAX_SKU_WEIGHT_GRAMS,
    description:
      'Static catalog weight in grams (positive whole number, ≤ 1,000,000). Omit to leave unchanged; null to clear.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_WEIGHT_GRAMS)
  weightGrams?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    example: 200,
    minimum: 1,
    maximum: MAX_SKU_DIMENSION_MM,
    description: 'Length in millimetres (positive whole number, ≤ 10,000). Omit to leave unchanged; null to clear.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  lengthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    example: 150,
    minimum: 1,
    maximum: MAX_SKU_DIMENSION_MM,
    description: 'Width in millimetres (positive whole number, ≤ 10,000). Omit to leave unchanged; null to clear.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  widthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    example: 100,
    minimum: 1,
    maximum: MAX_SKU_DIMENSION_MM,
    description: 'Height in millimetres (positive whole number, ≤ 10,000). Omit to leave unchanged; null to clear.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  heightMm?: number | null;

  // The `hsn` template: '' clears (mapped to null by the controller), so the
  // pattern admits the empty string; anything non-empty must be two uppercase
  // ISO 3166-1 alpha-2 letters. The same regex is `ORIGIN_RE` in
  // `sku-attributes.ts`, where the command re-checks it behind the replay.
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: 'IN',
    description:
      'Country of origin, ISO 3166-1 alpha-2 uppercase (e.g. IN, CN). Omit to leave unchanged; null or "" to clear.',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Matches(/^$|^[A-Z]{2}$/, {
    message: 'countryOfOrigin must be two uppercase ISO 3166-1 alpha-2 letters (e.g. IN, CN), empty to clear.',
  })
  countryOfOrigin?: string | null;

  @ApiProperty({
    required: false,
    example: 50,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
    description: QUANTITY_FIELD_DESCRIPTION,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  reorderPoint?: number;

  @ApiProperty({
    required: false,
    example: 100,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
    description: QUANTITY_FIELD_DESCRIPTION,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  reorderQty?: number;

  @ApiProperty({ required: false, minLength: 1, maxLength: 64 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(1, 64)
  barcode?: string;

  // Story 11.3 — the variant attach/detach fields. The `hsn` template again:
  // absent = unchanged, `null` (on productId) = detach and clear
  // variantValues with it. The command re-checks everything behind its
  // replay lookup (product existence → 404, the exact axis coverage → 400,
  // a duplicate variant → 409); this DTO is the wire shape only.
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Attach the SKU to this product (variantValues is then required), or null to detach it — variantValues are cleared with the detach.',
  })
  @IsOptional()
  @IsUUID()
  productId?: string | null;

  @ApiProperty({
    required: false,
    type: Object,
    nullable: true,
    example: { size: 'M', colour: 'Red' },
    description:
      'The SKU\'s values on the product\'s declared axes. Must cover EXACTLY the product\'s axes — a missing key, an unknown key or a blank value is a 400 naming the axis. Cannot ride a detach.',
  })
  @IsOptional()
  @IsObject()
  variantValues?: Record<string, string> | null;
}

// ── Story 11.3 — the product (AD-19): identity only, above `skus` ──────────

export class CreateProductDto {
  @ApiProperty({ minLength: 1, maxLength: PRODUCT_NAME_MAX, example: 'Oversized Tee' })
  @Trimmed()
  @IsString()
  @Length(1, PRODUCT_NAME_MAX)
  name!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_PRODUCT_AXES,
    example: ['size', 'colour'],
    description: `The declared variant axes, 1–${MAX_PRODUCT_AXES} short names. Immutable while variants are attached.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCT_AXES)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((axis: unknown) => (typeof axis === 'string' ? axis.trim() : axis)) : value))
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(AXIS_NAME_MAX, { each: true })
  axes!: string[];
}

/** PATCH fields on a product: name is always editable, axes only while empty. */
export class PatchProductDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: PRODUCT_NAME_MAX })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(1, PRODUCT_NAME_MAX)
  name?: string;

  @ApiProperty({
    required: false,
    type: [String],
    minItems: 1,
    maxItems: MAX_PRODUCT_AXES,
    description: 'The declared axes. Refused 409 `product-has-variants` while any SKU is attached.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCT_AXES)
  @IsString({ each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((axis: unknown) => (typeof axis === 'string' ? axis.trim() : axis)) : value))
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(AXIS_NAME_MAX, { each: true })
  axes?: string[];
}

export class ProductResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'Oversized Tee' })
  name!: string;

  @ApiProperty({ type: [String], example: ['size', 'colour'] })
  axes!: string[];

  @ApiProperty({ example: 2, description: 'How many SKUs in this tenant are attached to this product (derived, never stored)' })
  skuCount!: number;

  @ApiProperty({ example: '2026-09-19T00:00:00.000Z' })
  createdAt!: string;
}

export class ProductListResponse {
  @ApiProperty({ type: [ProductResponse] })
  items!: ProductResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

// ── Story 11.4 — kits and bundles (FR-38, AD-19): a kit IS a SKU ───────────

export class KitComponentDto {
  @ApiProperty({ format: 'uuid', description: 'The component SKU\'s id' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    example: 2,
    minimum: MIN_QUANTITY_BASE,
    maximum: MAX_QUANTITY_BASE,
    description: `Per ONE kit, in the component's own base UoM. ${QUANTITY_FIELD_DESCRIPTION}`,
  })
  @IsNumber()
  @Min(MIN_QUANTITY_BASE)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;
}

/** PUT /kit — the full BOM replaces whatever composition the SKU carried. */
export class PutKitDto {
  @ApiProperty({
    type: [KitComponentDto],
    minItems: 1,
    maxItems: MAX_KIT_COMPONENTS,
    description: `The flat BOM — at least one component, at most ${MAX_KIT_COMPONENTS}, no repeats, no kit-of-kit.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KIT_COMPONENTS)
  @ValidateNested({ each: true })
  @Type(() => KitComponentDto)
  components!: KitComponentDto[];
}

export class KitComponentResponse {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ example: 'CHILI-100' })
  code!: string;

  @ApiProperty({ example: 2, description: 'Per ONE kit, in the component\'s base UoM' })
  qty!: number;
}

export class KitResponse {
  @ApiProperty({ format: 'uuid', description: 'The kit SKU\'s id — a kit IS a SKU' })
  skuId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'FIRSTAID-KIT' })
  code!: string;

  @ApiProperty({ example: 'First-aid kit' })
  name!: string;

  @ApiProperty({ type: [KitComponentResponse] })
  components!: KitComponentResponse[];

  @ApiProperty({ example: '2026-09-20T00:00:00.000Z' })
  createdAt!: string;
}

export class KitListResponse {
  @ApiProperty({ type: [KitResponse] })
  items!: KitResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}