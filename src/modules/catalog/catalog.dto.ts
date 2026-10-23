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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SKU_STATUSES, type SkuStatus } from '../../shared/db/schema';
import { IMPORT_MODES, GST_RATE_BPS_MAX } from './import.command';
import { BATCH_BLOCK_NOTE_MAX, BATCH_BLOCK_REASONS, type BatchBlockReason } from './batch-block.command';
// Story 12-1: the storage-class vocabulary — the DTO mirror of the shared
// primitive's tuple (the three-layer pattern: TS tuple / DB CHECK / @IsIn).
import { STORAGE_CLASSES } from '../../shared/primitives/storage-class';
// Story 12-2 — the hazard vocabulary tuple, the same three-layer pattern.
import { HAZARD_CLASSES } from '../../shared/primitives/hazard';
// Story 5-3: the ABC-class vocabulary — the DTO mirror of the shared
// primitive's tuple (the three-layer pattern).
import { ABC_CLASSES } from '../../shared/primitives/abc-class';
import { UOMS } from './uom';
// Story 1-6a — the goods-type vocabularies (the three-layer pattern).
import {
  ALLERGENS,
  DG_CLASSES,
  DG_PACKING_GROUPS,
  DRUG_SCHEDULES,
  FOOD_CATEGORIES,
  MAX_DG_SUBSIDIARY_CLASSES,
  MAX_STACK_LAYERS,
  MIN_STACK_LAYERS,
} from '../../shared/primitives/goods-type';
import { MAX_SKU_DIMENSION_MM, MAX_SKU_WEIGHT_GRAMS } from './sku-attributes';
import { AXIS_NAME_MAX, MAX_PRODUCT_AXES, PRODUCT_NAME_MAX } from './product.command';
import { MAX_KIT_COMPONENTS } from './kit.command';
// Story 1-4 — the SKU master's shared bounds (the DTO mirrors; the command is the boundary).
import {
  BARCODE_MAX,
  BARCODE_RE,
  HSN_MAX,
  MAX_EXTRA_BARCODES,
  MAX_PACK_FACTOR,
  MAX_PACK_LEVELS,
  MAX_SHELF_LIFE_DAYS,
  MIN_PACK_FACTOR,
  MIN_SHELF_LIFE_DAYS,
  SKU_CODE_MAX,
  SKU_NAME_MAX,
} from './sku-master';

/** Story 1-4 (decision 12) — the barcode rule as two DTO patterns (printable ASCII, trimmed; no `;`). */
const BarcodeRule = () => (target: object, key: string | symbol) => {
  Matches(BARCODE_RE, { message: `${String(key)} must be printable ASCII with no leading or trailing space` })(target, key);
  Matches(/^[^;]*$/, { message: `${String(key)} may not contain ";"` })(target, key);
};

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

  // Story 21-2b (decision 4) — the ONE client this run's new SKUs belong to.
  // A request-SHAPE check only (uuid → 400 here, above the transaction); an
  // unknown client is the command's 404, behind the replay lookup. A blank
  // multipart field reads as absent.
  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      "Story 21-2b — the client the new SKUs belong to. Required (400 client-required) once the tenant holds more than one client; absent = the tenant's own client while it is the only one. A fix-mode re-run inherits its original run's client — naming a different one is a 400",
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  clientId?: string;
}

/** Story 21-2b — `POST …/catalog/skus/{skuId}/client`: the owner's correction. */
export class CorrectSkuClientDto {
  @ApiProperty({ format: 'uuid', description: 'The client the SKU belongs to instead (any client of this tenant, including its own `self` client)' })
  @IsUUID()
  clientId!: string;
}

export class CatalogImportErrorResponse {
  @ApiProperty({ example: 3, description: '1-based data-row index (header excluded)' })
  rowNumber!: number;

  @ApiProperty({ type: String, nullable: true, example: 'MAS-CHILI-100', description: 'Absent when the row failed shape validation before a code could be read' })
  skuCode!: string | null;

  @ApiProperty({ example: 'duplicate-sku-code', description: 'validation-failed | duplicate-sku-code | duplicate-barcode | … ; story 1-6a adds dg-hazard-mismatch (a hazard_class cell disagreeing with dg_class) and dg-hazard-required (dg_class 8 with a blank hazard_class — write corrosive-acid, corrosive-base or none)' })
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

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: 'Story 21-2b — the client this run imported for (a fix-mode re-run inherits it). Absent only on a replayed response stored before 21-2b',
  })
  clientId?: string | null;
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

/** Story 1-4 — one barcode of a SKU with its level. */
export class SkuBarcodeResponse {
  @ApiProperty({ example: '8901234567890' })
  barcode!: string;

  @ApiProperty({ example: 'case', enum: [...UOMS], description: 'The level this barcode names — the SKU\'s base uom or one of its pack levels' })
  uom!: string;

  @ApiProperty({ example: false, description: 'The primary barcode (always at the base uom; equals `barcode` on the SKU)' })
  isPrimary!: boolean;
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

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      "Story 21-2b — the client this SKU belongs to (set at import; correctable by an owner only while the SKU has no history). Absent only on a replayed edit response stored before 21-2b",
  })
  clientId?: string | null;

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

  // Story 12-1: the controlled-vocabulary storage class (required — every SKU
  // carries one; pre-12.1 rows read 'ambient').
  @ApiProperty({ enum: STORAGE_CLASSES, example: 'ambient' })
  storageClass!: string;

  // Story 12-2: the controlled-vocabulary hazard class (FR-41), required but
  // NULLABLE — toSnapshot always sets it, and every pre-12.2 row (and import
  // row without the cell) reads null.
  @ApiProperty({
    enum: HAZARD_CLASSES,
    nullable: true,
    example: 'flammable',
    description: 'The SKU\'s hazard class (FR-41), or null when it carries none. Null carries no rule in either direction of the segregation matrix.',
  })
  hazardClass!: string | null;

  // Story 5-3: the controlled-vocabulary ABC class (FR-cycle-count), required
  // but NULLABLE (the hazardClass twin) — toSnapshot always sets it, and
  // every pre-5.3 row (and import row without the cell) reads null.
  @ApiProperty({
    enum: ABC_CLASSES,
    nullable: true,
    example: 'a',
    description:
      'The SKU\'s ABC classification the cycle-count scheduler schedules from, or null when it is not yet classified — a null class is EXCLUDED from scheduled count generation (on-demand still covers its bin, OQ-1).',
  })
  abcClass!: string | null;

  @ApiProperty({ example: '0198f7a2-1b3c-7d4e-8f90-112233445588', description: 'Generated server-side (uuidv7) unless provided' })
  barcode!: string;

  @ApiProperty({
    type: [SkuUomConversionResponse],
    description: 'Story 1-4 — the SKU\'s pack levels (one unit of `uom` = `factor` base units), sorted by uom',
  })
  uomConversions!: SkuUomConversionResponse[];

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 365,
    description:
      'Story 1-4 — total shelf life in days from manufacture (1–3650), or null when unset. Not the client policy\'s minimum REMAINING shelf life.',
  })
  shelfLifeDays!: number | null;

  @ApiProperty({
    type: [SkuBarcodeResponse],
    description: 'Story 1-4 — every barcode of the SKU with its level: the primary first, then by (uom, barcode). Empty only on a replayed response stored before 1-4',
  })
  barcodes!: SkuBarcodeResponse[];

  @ApiProperty({
    enum: [...SKU_STATUSES],
    description:
      'Story 1-4b — `inactive`: the SKU takes no new POs, ASNs, kits or channel mappings, sells down only what stock covers in full, and publishes 0 to its channels. `active` on every response stored before 1-4b',
  })
  status!: SkuStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Story 1-4b — why it was deactivated; null unless inactive (and optional then)' })
  inactiveReason!: string | null;

  // Story 1-6a — the goods-type attributes. A replay of a response stored
  // before 1-6a serves `[]`, `null` and `false` (`normalizeStoredSku`).
  @ApiProperty({ type: [String], enum: DRUG_SCHEDULES, example: ['H'], description: 'Story 1-6a — drug schedules, sorted; empty when not a scheduled drug' })
  drugSchedules!: string[];

  @ApiProperty({ enum: FOOD_CATEGORIES, nullable: true, example: 'dairy', description: 'Story 1-6a — the food category; `non-food` declares the SKU not food, null means not set' })
  foodCategory!: string | null;

  @ApiProperty({ type: [String], enum: ALLERGENS, example: ['milk'], description: 'Story 1-6a — FSSAI allergens, sorted; only with a food category that is not non-food' })
  allergens!: string[];

  @ApiProperty({ type: String, nullable: true, example: '1203', description: 'Story 1-6a — the UN number, four digits without the "UN" prefix; set together with dgClass' })
  dgUnNumber!: string | null;

  @ApiProperty({ enum: DG_CLASSES, nullable: true, example: '3', description: 'Story 1-6a — the primary dangerous-goods class; a mapped class sets hazardClass' })
  dgClass!: string | null;

  @ApiProperty({ type: [String], enum: DG_CLASSES, example: ['6.1'], description: 'Story 1-6a — up to two subsidiary DG classes, sorted, never the primary' })
  dgSubsidiaryClasses!: string[];

  @ApiProperty({ enum: DG_PACKING_GROUPS, nullable: true, example: 'II', description: 'Story 1-6a — the UN packing group; none for classes 1, 2, 5.2, 6.2 and 7' })
  dgPackingGroup!: string | null;

  @ApiProperty({ example: false, description: 'Story 1-6a — a handling and insurance marker; placement stays governed by storage class' })
  highValue!: boolean;

  @ApiProperty({ example: false, description: 'Story 1-6a — handle with care' })
  fragile!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4,
    description: 'Story 1-6a — how many of the SKU\'s outermost received units may stand on one another (1 = do not stack); shown, not enforced',
  })
  maxStackLayers!: number | null;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

/** Story 1-4b — `PATCH …/catalog/skus/{skuId}/status`. */
export class UpdateSkuStatusDto {
  @ApiProperty({
    enum: [...SKU_STATUSES],
    description: '`inactive` stops new inbound, kits and channel listings and sells down what is left; `active` restores it and clears the reason',
  })
  @IsIn(SKU_STATUSES)
  status!: SkuStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: 500,
    description: 'Why it was deactivated — only with `inactive`; trimmed, at most 500 characters',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  // The 500-code-point rule is the command's (behind the replay, trimmed);
  // this edge cap (UTF-16 units) only bounds the body — the partners shape.
  @MaxLength(2000)
  reason?: string | null;
}

/** Story 1-4 — the create's and the packaging PUT's response. */
export class SkuWriteResponse {
  @ApiProperty({ type: SkuResponse })
  sku!: SkuResponse;
}

/** Story 1-4 — one pack level: one unit of `uom` = `factor` base units. */
export class PackLevelDto {
  @ApiProperty({
    example: 'case',
    maxLength: 32,
    description: 'The level\'s unit — the uom vocabulary (aliases such as `cases` resolve); never the SKU\'s base uom',
  })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  uom!: string;

  @ApiProperty({ example: 12, minimum: MIN_PACK_FACTOR, maximum: MAX_PACK_FACTOR, description: 'Base units in one unit of this level — a whole number' })
  @IsInt()
  @Min(MIN_PACK_FACTOR)
  @Max(MAX_PACK_FACTOR)
  factor!: number;
}

/** Story 1-4 — one non-primary barcode and the level it names. */
export class ExtraBarcodeDto {
  @ApiProperty({ example: '8901234567890', minLength: 1, maxLength: BARCODE_MAX, description: 'Printable ASCII, trimmed, no ";"' })
  @Trimmed()
  @IsString()
  @Length(1, BARCODE_MAX)
  @BarcodeRule()
  barcode!: string;

  @ApiProperty({ example: 'case', maxLength: 32, description: 'The SKU\'s base uom (an extra base-level barcode) or one of its pack levels' })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  uom!: string;
}

/** Story 1-4 — `PUT …/catalog/skus/{skuId}/packaging`: the full set of levels and non-primary barcodes. */
export class ReplacePackagingDto {
  @ApiProperty({ type: [PackLevelDto], maxItems: MAX_PACK_LEVELS, description: 'Every pack level the SKU carries afterwards (replace semantics)' })
  @IsArray()
  @ArrayMaxSize(MAX_PACK_LEVELS)
  @ValidateNested({ each: true })
  @Type(() => PackLevelDto)
  levels!: PackLevelDto[];

  @ApiProperty({
    type: [ExtraBarcodeDto],
    maxItems: MAX_EXTRA_BARCODES,
    description: 'Every NON-primary barcode the SKU carries afterwards (the primary is edited through the SKU PATCH)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_EXTRA_BARCODES)
  @ValidateNested({ each: true })
  @Type(() => ExtraBarcodeDto)
  barcodes!: ExtraBarcodeDto[];
}

/** Story 1-4 — the physical attributes on a create (the PATCH's fields, nested). */
export class SkuAttributesDto {
  @ApiProperty({ required: false, example: 500, minimum: 1, maximum: MAX_SKU_WEIGHT_GRAMS, description: 'Static catalog weight in grams' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_WEIGHT_GRAMS)
  weightGrams?: number;

  @ApiProperty({ required: false, example: 200, minimum: 1, maximum: MAX_SKU_DIMENSION_MM })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  lengthMm?: number;

  @ApiProperty({ required: false, example: 150, minimum: 1, maximum: MAX_SKU_DIMENSION_MM })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  widthMm?: number;

  @ApiProperty({ required: false, example: 100, minimum: 1, maximum: MAX_SKU_DIMENSION_MM })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SKU_DIMENSION_MM)
  heightMm?: number;

  @ApiProperty({ required: false, example: 'IN', description: 'ISO 3166-1 alpha-2 uppercase' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Matches(/^$|^[A-Z]{2}$/, { message: 'countryOfOrigin must be two uppercase ISO 3166-1 alpha-2 letters (e.g. IN, CN).' })
  countryOfOrigin?: string;
}

/**
 * Story 1-6a — the goods-type fields the create and the edit PATCH share.
 * Absent = not sent (the edit leaves the field unchanged); `null` clears a
 * nullable field. An explicit `null` for `highValue`, `fragile` or one of the
 * arrays is refused 400 by the controller (`@IsOptional` skips null — the
 * `storageClass` precedent). The command is the boundary: canonicalisation
 * (the `UN` prefix stripped, arrays sorted and de-duplicated) and every
 * pairing rule (`assertGoodsType`) run there, behind the replay lookup.
 */
export class GoodsTypeFieldsDto {
  @ApiProperty({ required: false, type: [String], enum: DRUG_SCHEDULES, example: ['H'], description: 'Drug schedules (a drug may carry several, e.g. C and H)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DRUG_SCHEDULES.length)
  @IsIn(DRUG_SCHEDULES, { each: true })
  drugSchedules?: string[];

  @ApiProperty({ required: false, enum: FOOD_CATEGORIES, nullable: true, example: 'dairy', description: '`non-food` declares the SKU not food; null clears' })
  @IsOptional()
  @IsIn(FOOD_CATEGORIES)
  foodCategory?: string | null;

  @ApiProperty({ required: false, type: [String], enum: ALLERGENS, example: ['milk'], description: 'FSSAI allergens — only with a food category that is not non-food' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ALLERGENS.length)
  @IsIn(ALLERGENS, { each: true })
  allergens?: string[];

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: 'UN1203',
    pattern: '^([Uu][Nn])?\\d{4}$',
    description: 'The UN number 0001–3599, with or without the "UN" prefix (any case; stored without it). Set together with dgClass; null clears',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Matches(/^(UN)?\d{4}$/i, { message: 'dgUnNumber must be four digits, optionally prefixed "UN"' })
  dgUnNumber?: string | null;

  @ApiProperty({
    required: false,
    enum: DG_CLASSES,
    nullable: true,
    example: '3',
    description: 'The primary DG class. 1.x → explosive, 2.x → gas, 3 → flammable, 5.1 → oxidizer, 6.1 → toxic set hazardClass; 8 needs hazardClass corrosive-acid, corrosive-base or null; null clears',
  })
  @IsOptional()
  @IsIn(DG_CLASSES)
  dgClass?: string | null;

  @ApiProperty({ required: false, type: [String], enum: DG_CLASSES, maxItems: MAX_DG_SUBSIDIARY_CLASSES, example: ['6.1'], description: 'Up to two subsidiary DG classes, never the primary, only with a primary' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DG_CLASSES.length)
  @IsIn(DG_CLASSES, { each: true })
  dgSubsidiaryClasses?: string[];

  @ApiProperty({ required: false, enum: DG_PACKING_GROUPS, nullable: true, example: 'II', description: 'I, II or III; none for classes 1, 2, 5.2, 6.2 and 7; null clears' })
  @IsOptional()
  @IsIn(DG_PACKING_GROUPS)
  dgPackingGroup?: string | null;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  highValue?: boolean;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  fragile?: boolean;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: MIN_STACK_LAYERS,
    maximum: MAX_STACK_LAYERS,
    example: 4,
    description: 'How many of the SKU\'s outermost received units may stand on one another (1 = do not stack); null clears',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_STACK_LAYERS)
  @Max(MAX_STACK_LAYERS)
  maxStackLayers?: number | null;
}

/** Story 1-4 — `POST …/catalog/skus`: one import row's worth of fields, typed. */
export class CreateSkuDto extends GoodsTypeFieldsDto {
  @ApiProperty({ example: 'TEA-1', minLength: 1, maxLength: SKU_CODE_MAX, description: 'Unique in the client; immutable' })
  @Trimmed()
  @IsString()
  @Length(1, SKU_CODE_MAX)
  code!: string;

  @ApiProperty({ example: 'Assam tea 250g', minLength: 1, maxLength: SKU_NAME_MAX })
  @Trimmed()
  @IsString()
  @Length(1, SKU_NAME_MAX)
  name!: string;

  @ApiProperty({ example: 'each', maxLength: 32, description: 'The base unit — the uom vocabulary; aliases such as `pcs` resolve. Immutable' })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  uom!: string;

  @ApiProperty({ example: 1800, minimum: 0, maximum: GST_RATE_BPS_MAX, description: 'GST in basis points (1800 = 18%)' })
  @IsInt()
  @Min(0)
  @Max(GST_RATE_BPS_MAX)
  gstRate!: number;

  @ApiProperty({ required: false, maxLength: HSN_MAX, example: '09023020' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(0, HSN_MAX)
  hsnCode?: string;

  @ApiProperty({
    required: false,
    maxLength: BARCODE_MAX,
    example: '8901234567890',
    description: 'The primary (base-level) barcode. Omitted or blank → generated server-side, as the import does',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(0, BARCODE_MAX)
  @Matches(/^$|^[!-~]([ -~]*[!-~])?$/, { message: 'barcode must be printable ASCII with no leading or trailing space' })
  @Matches(/^[^;]*$/, { message: 'barcode may not contain ";"' })
  barcode?: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  batchTracked!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  serialTracked!: boolean;

  @ApiProperty({ example: false, description: 'Handled by unit, priced by weight. Mutually exclusive with serialTracked' })
  @IsBoolean()
  catchWeightTracked!: boolean;

  @ApiProperty({ required: false, type: SkuAttributesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SkuAttributesDto)
  attributes?: SkuAttributesDto;

  @ApiProperty({ required: false, enum: STORAGE_CLASSES, example: 'ambient', description: 'Defaults to ambient' })
  @IsOptional()
  @IsIn(STORAGE_CLASSES)
  storageClass?: string;

  @ApiProperty({
    required: false,
    enum: HAZARD_CLASSES,
    nullable: true,
    example: 'flammable',
    description:
      'Story 1-6a — omitted, a mapped dgClass derives it; with dgClass 8 send corrosive-acid, corrosive-base or null (none). A value that disagrees with the DG class is 400 dg-hazard-mismatch',
  })
  @IsOptional()
  @IsIn(HAZARD_CLASSES)
  hazardClass?: string | null;

  @ApiProperty({ required: false, enum: ABC_CLASSES, example: 'a' })
  @IsOptional()
  @IsIn(ABC_CLASSES)
  abcClass?: string;

  @ApiProperty({ required: false, example: 50, minimum: 0, maximum: MAX_QUANTITY_BASE, description: QUANTITY_FIELD_DESCRIPTION })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  reorderPoint?: number;

  @ApiProperty({ required: false, example: 100, minimum: 0, maximum: MAX_QUANTITY_BASE, description: QUANTITY_FIELD_DESCRIPTION })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  reorderQty?: number;

  @ApiProperty({
    required: false,
    example: 365,
    minimum: MIN_SHELF_LIFE_DAYS,
    maximum: MAX_SHELF_LIFE_DAYS,
    description: 'Total shelf life in days from manufacture',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_SHELF_LIFE_DAYS)
  @Max(MAX_SHELF_LIFE_DAYS)
  shelfLifeDays?: number;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'The client the SKU belongs to. Required (400 client-required) once the tenant holds more than one client',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, type: [PackLevelDto], maxItems: MAX_PACK_LEVELS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PACK_LEVELS)
  @ValidateNested({ each: true })
  @Type(() => PackLevelDto)
  levels?: PackLevelDto[];

  @ApiProperty({ required: false, type: [ExtraBarcodeDto], maxItems: MAX_EXTRA_BARCODES, description: 'Non-primary barcodes, each naming its level' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXTRA_BARCODES)
  @ValidateNested({ each: true })
  @Type(() => ExtraBarcodeDto)
  barcodes?: ExtraBarcodeDto[];
}

/** Story 21-2b — the client correction's response: every SKU it moved (the named one first). */
export class SkuClientCorrectionResponse {
  @ApiProperty({
    type: [SkuResponse],
    description: 'Every SKU the correction moved — the named SKU first, then its kit partners and product siblings (a kit and a product never span clients, so they move as one group). On a no-op (already on that client) just the named SKU',
  })
  skus!: SkuResponse[];
}

export class SkuListResponse {
  @ApiProperty({ type: [SkuResponse] })
  items!: SkuResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

// ── Story 12-7 — the segregation matrix read (FR-41, the admin view) ────────

/** One incompatible unordered pair — sorted keys (`a` < `b` lexicographically). */
export class SegregationPairResponse {
  @ApiProperty({ enum: HAZARD_CLASSES, example: 'oxidizer' })
  a!: string;

  @ApiProperty({ enum: HAZARD_CLASSES, example: 'flammable' })
  b!: string;
}

/**
 * Story 1-6b — one co-location rule as the matrix read serves it. `code` is
 * a plain string (not an OpenAPI enum): a client renders the list keyed on
 * it, and a new rule must not break an older client's types.
 */
export class SegregationRuleDto {
  @ApiProperty({ example: 'food-chemical', description: 'The rule\'s machine code (hazard-pair, explosive-dg, food-chemical, drug-chemical, allergen-mismatch, raw-ready-to-eat today)' })
  code!: string;

  @ApiProperty({ example: 'A scheduled drug never shares a bin with a chemical.', description: 'The rule in one sentence, for display verbatim' })
  description!: string;
}

/**
 * The hazard segregation matrix as data: the closed vocabulary and the FULLY
 * EXPANDED incompatible unordered-pair set — the explosive universal rule
 * enumerated as pairs (incl. `explosive|explosive`) plus the explicit pairs.
 * The web renders `compatible(a, b) = !incompatible.includes(pair)` with zero
 * logic of its own; a null hazard class is not a class and carries no rule
 * (it never appears here and is always compatible).
 */
export class SegregationMatrixResponse {
  @ApiProperty({ type: [String], enum: HAZARD_CLASSES, example: [...HAZARD_CLASSES] })
  classes!: string[];

  @ApiProperty({ type: [SegregationPairResponse], description: 'Every incompatible unordered pair, fully expanded (11 today: the 7 explosive pairs incl. self + the 4 explicit ones)' })
  incompatible!: SegregationPairResponse[];

  @ApiProperty({
    type: [SegregationRuleDto],
    description:
      'Story 1-6b — every co-location rule, in the order the gates check them: the hazard grid above (with DG subsidiaries), explosives vs any dangerous good, food and scheduled drugs vs chemicals, allergens, raw vs ready-to-eat',
  })
  rules!: SegregationRuleDto[];
}

/** PATCH fields (spec 1.4): SKU code is immutable; barcode is changeable. */
export class PatchSkuDto extends GoodsTypeFieldsDto {
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

  @ApiProperty({ required: false, minLength: 1, maxLength: 64, description: 'The primary barcode — printable ASCII, trimmed, no ";". A value that is this SKU\'s extra barcode is promoted' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @Length(1, 64)
  @BarcodeRule()
  barcode?: string;

  // Story 1-4 — total shelf life in days from manufacture. Absent =
  // unchanged, null = clear (`@IsOptional` lets null through; the command
  // clears on it and re-checks the range behind its replay lookup).
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    example: 365,
    minimum: MIN_SHELF_LIFE_DAYS,
    maximum: MAX_SHELF_LIFE_DAYS,
    description: 'Total shelf life in days from manufacture (1–3650). Omit to leave unchanged; null to clear.',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_SHELF_LIFE_DAYS)
  @Max(MAX_SHELF_LIFE_DAYS)
  shelfLifeDays?: number | null;

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

  // Story 12-1: the SKU's storage class (FR-40) — absent = unchanged (there
  // is no null: the column is NOT NULL, a SKU always carries a class). The
  // vocabulary is pinned HERE with `@IsIn` and re-checked in the command
  // (`assertStorageClass`, behind the replay lookup — the mirror is not the
  // boundary). A change runs the stock-conformance guard (409
  // `storage-class-conflict`).
  @ApiProperty({
    required: false,
    enum: STORAGE_CLASSES,
    example: 'ambient',
    description:
      'The SKU\'s storage class (FR-40): ambient, chilled, frozen, controlled, hazardous or secure. Omit to leave unchanged.',
  })
  @IsOptional()
  @IsIn(STORAGE_CLASSES)
  storageClass?: string;

  // Story 12-2: the SKU's hazard class (FR-41) — absent = unchanged, NULL =
  // clear (the 11.2 attribute template; the column is nullable, so the clear
  // verb exists and there is NO explicit-null 400 at the controller, unlike
  // `storageClass`). The vocabulary is pinned HERE with `@IsIn` and
  // re-checked in the command (`assertHazardClass`, which skips null — the
  // clear verb — behind the replay lookup; the mirror is not the boundary).
  // Story 1-6a: a mapped DG class decides it (`resolveHazardClass`,
  // decision 7) — null no longer always succeeds. A change runs the
  // co-location guard (409 `hazard-segregation-conflict`).
  @ApiProperty({
    required: false,
    enum: HAZARD_CLASSES,
    nullable: true,
    example: 'flammable',
    description:
      'The SKU\'s hazard class (FR-41): explosive, oxidizer, flammable, corrosive-acid, corrosive-base, toxic or gas. Omit to leave unchanged — or, when the SKU\'s resulting dgClass is mapped (1.x, 2.x, 3, 5.1, 6.1), to take the derived class. null clears it unless the DG class sets one (400 dg-hazard-mismatch); with dgClass 8 only corrosive-acid, corrosive-base or null are accepted, and changing into class 8 from a non-corrosive needs one of them (400 dg-hazard-required). A change to a non-null class runs the co-location guard.',
  })
  @IsOptional()
  @IsIn(HAZARD_CLASSES)
  hazardClass?: string | null;

  // Story 5-3: the SKU's ABC class (FR-cycle-count) — absent = unchanged,
  // NULL = clear (the `hazardClass` twin; the column is nullable, so the
  // clear verb exists — a null class is excluded from scheduled count
  // generation, OQ-1). The vocabulary is pinned HERE with `@IsIn` and
  // re-checked in the command (`assertAbcClass`, which skips null — the
  // clear verb — behind the replay lookup; the mirror is not the boundary).
  @ApiProperty({
    required: false,
    enum: ABC_CLASSES,
    nullable: true,
    example: 'a',
    description:
      'The SKU\'s ABC classification (FR-cycle-count): a, b or c. Omit to leave unchanged; null clears the class (excludes the SKU from scheduled count generation, on-demand still covers it).',
  })
  @IsOptional()
  @IsIn(ABC_CLASSES)
  abcClass?: string | null;
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

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Story 1-4 — the client the product belongs to. Required (400 client-required) once the tenant holds more than one client',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
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

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Story 1-4 — moves the product to another client; refused 409 `product-has-skus` while any SKU is attached',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

export class ProductResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'Oversized Tee' })
  name!: string;

  @ApiProperty({ format: 'uuid', description: 'Story 1-4 — the client the product belongs to; every attached SKU shares it' })
  clientId!: string;

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
  // NO @ArrayMinSize: an empty array must reach the command, whose guard
  // answers the NAMED 400 `empty-kit-composition` — a generic DTO
  // validation-failed would bury the arm the contract pins.
  @IsArray()
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
// ── story 3-3a: block / unblock a batch ─────────────────────────────────────

/** `POST …/inventory/batches/{batchId}/block` body. */
export class BlockBatchDto {
  @ApiProperty({
    enum: [...BATCH_BLOCK_REASONS],
    description: 'Why the lot is blocked — `other` requires a note',
  })
  @IsIn(BATCH_BLOCK_REASONS)
  reason!: BatchBlockReason;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: BATCH_BLOCK_NOTE_MAX,
    description: `What happened — trimmed, at most ${BATCH_BLOCK_NOTE_MAX} characters; required when reason is \`other\``,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  // The 500-code-point rule is the command's (trimmed); this edge cap (UTF-16
  // units) only bounds the body — the SKU status shape.
  @MaxLength(2000)
  note?: string | null;
}

/** `POST …/inventory/batches/{batchId}/unblock` body — lifting a block always says why (A8). */
export class UnblockBatchDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: BATCH_BLOCK_NOTE_MAX,
    description: `Why the block is lifted — required, trimmed, 1–${BATCH_BLOCK_NOTE_MAX} characters`,
  })
  @IsString()
  @MaxLength(2000)
  note!: string;
}

/** A batch's identity and lifecycle facts (story 3-3a) — the block verbs' answer. */
export class BatchLifecycleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Batch code (unique per tenant + SKU)' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Manufacturing date (ISO-8601 UTC), null when unrecorded' })
  mfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Expiry instant (ISO-8601 UTC — the IST midnight beginning the label date), null when unrecorded' })
  expiryDate!: string | null;

  @ApiProperty({ enum: ['active', 'blocked'], description: '`blocked` — on hand but never promised or default-drawn, in every warehouse' })
  status!: 'active' | 'blocked';

  @ApiProperty({ type: String, nullable: true, enum: [...BATCH_BLOCK_REASONS, null], description: 'Why it is blocked — null unless blocked' })
  blockedReason!: BatchBlockReason | null;

  @ApiProperty({ type: String, nullable: true, description: "The block's note (always present with reason `other`) — null when none was given or not blocked" })
  blockedNote!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When it was blocked (ISO-8601 UTC) — null unless blocked' })
  blockedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Who blocked it — null unless blocked' })
  blockedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The blocker's display name (the member's email handle) — null unless blocked" })
  blockedByName!: string | null;

  @ApiProperty({ description: 'The server judged the batch past its expiry instant — expired stock is on hand but never promised or default-drawn (blocked or not)' })
  expired!: boolean;
}

/** The block / unblock response. */
export class BatchBlockResponse {
  @ApiProperty({ type: BatchLifecycleDto })
  batch!: BatchLifecycleDto;
}
