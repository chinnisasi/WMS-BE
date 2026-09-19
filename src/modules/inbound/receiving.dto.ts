import { Type } from 'class-transformer';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_DECIMALS,
  QUANTITY_FIELD_DESCRIPTION,
} from '../../shared/primitives/quantity';
import { UOMS } from '../catalog/uom';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PurchaseOrderLineDto } from './inbound.dto';
import {
  MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  MAX_HANDLING_UNITS_PER_REQUEST,
} from '../catalog/handling-unit';
import { MAX_HANDLING_UNITS_PER_GRN_LINE } from './receiving.command';
// Story 3.5 (additive): the snapshot's putaway decision fields reuse the
// putaway module's DTOs (one shape on every surface).
import { PutawayBinDto, PutawayTaskDto } from '../putaway/putaway.dto';
import { PickTaskDto } from '../outbound/outbound.dto';

/** The fixed blind-receive reason enum (the I/O matrix). */
export const BLIND_REASON_ENUM = ['unannounced-delivery', 'po-not-found', 'other'] as const;

// ── grn.submit input ─────────────────────────────────────────────────────────

/** One received (sku, batch) line as the device submits it. */
export class GrnLineInputDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'The PO line received against — null on a blind receipt\'s lines',
  })
  @IsOptional()
  @IsUUID()
  poLineId?: string | null;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'Catalog batch code (required for batch-tracked SKUs, forbidden otherwise)',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/\S/, { message: 'batchCode must contain non-whitespace characters' })
  batchCode?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'Optional batch mfg date (ISO-8601 UTC, Z-suffixed)',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  mfgDate?: string | null;

  @ApiProperty({
    description: `Physically received quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({
    required: false,
    type: [Number],
    nullable: true,
    maxItems: MAX_HANDLING_UNITS_PER_GRN_LINE,
    // (the command additionally caps the REQUEST at
    // MAX_HANDLING_UNITS_PER_REQUEST across every line)
    description:
      'Catch weight (story 10.3): one captured weight in whole GRAMS per physical unit on this line — required for a catch-weight-tracked SKU, refused for every other SKU, and exactly qty entries long. It is a per-unit actual weight, never a quantity and never the parcel weight pack records.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(Math.min(MAX_HANDLING_UNITS_PER_GRN_LINE, MAX_HANDLING_UNITS_PER_REQUEST))
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_HANDLING_UNIT_WEIGHT_GRAMS, { each: true })
  weightsGrams?: number[] | null;
}

/** POST /tenants/{tenantId}/receiving/goods-receipts body (device session). */
export class SubmitGoodsReceiptDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the receipt lands in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'The purchase order received against — null on a blind receipt',
  })
  @IsOptional()
  @IsUUID()
  poId?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: BLIND_REASON_ENUM,
    description: 'The blind-receive reason code (required when poId is null, forbidden otherwise)',
  })
  @IsOptional()
  @IsIn(BLIND_REASON_ENUM as unknown as string[])
  blindReasonCode?: string | null;

  @ApiProperty({ description: 'Device time of the receipt (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    type: [GrnLineInputDto],
    minItems: 1,
    maxItems: 200,
    description: 'The physically received lines',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => GrnLineInputDto)
  lines!: GrnLineInputDto[];
}

// ── grn responses ────────────────────────────────────────────────────────────

/** One GRN line as every surface returns it. */
export class GrnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  // The schema floor matches the receipt validator (@Min(0.001)): physical
  // truth is fractional since story 10-1, so a sub-1 line quantity is real.
  @ApiProperty({ description: 'Physical truth: everything that arrived', minimum: 0.001 })
  qty!: number;

  @ApiProperty({ description: 'The within-open portion applied immediately', minimum: 0 })
  appliedQty!: number;

  @ApiProperty({ description: 'The excess pended for approval', minimum: 0 })
  excessQty!: number;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Catch weight (story 10.3): the handling units this line produced, in the order their weights were supplied — present only on a catch-weight line. These ids are what a unit label carries and what the pack bench scans back.',
  })
  handlingUnitIds?: readonly string[];
}

/** One line the server refused to settle (naming the reason — the others settle). */
export class RejectedGrnLineDto {
  @ApiProperty({ format: 'uuid' })
  poLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ minimum: 1 })
  qty!: number;

  @ApiProperty({ description: 'Machine reason (po-line-not-found | po-line-not-open)' })
  code!: string;

  @ApiProperty({ description: 'Human-readable reason naming the line state' })
  reason!: string;
}

/** The GRN as the submit response / replay returns it. */
export class GoodsReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Server-assigned code (GRN-<n>, unique per tenant)' })
  code!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poId!: string | null;

  @ApiProperty({ enum: BLIND_REASON_ENUM, type: String,
    nullable: true })
  blindReasonCode!: string | null;

  @ApiProperty({ description: 'recorded (the v1 terminal state)' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ description: 'Device time (AD-1), ISO-8601 UTC' })
  occurredAt!: string;

  @ApiProperty({ description: 'Server ingest time (AD-1), ISO-8601 UTC' })
  recordedAt!: string;

  @ApiProperty({ type: [GrnLineDto] })
  lines!: readonly GrnLineDto[];

  @ApiProperty({ type: [RejectedGrnLineDto], required: false })
  rejectedLines?: readonly RejectedGrnLineDto[];
}

export class GoodsReceiptResponse {
  @ApiProperty({ type: GoodsReceiptDto })
  goodsReceipt!: GoodsReceiptDto;
}

/** One GRN header of the list read. */
export class GoodsReceiptEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Server-assigned code (GRN-<n>)' })
  code!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poId!: string | null;

  @ApiProperty({ enum: BLIND_REASON_ENUM, type: String,
    nullable: true, description: 'Set only on a blind receipt' })
  blindReasonCode!: string | null;

  @ApiProperty({ description: 'recorded (the v1 terminal state)' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ description: 'Device time (ISO-8601 UTC)' })
  occurredAt!: string;

  @ApiProperty({ description: 'Server ingest time (ISO-8601 UTC)' })
  recordedAt!: string;

  @ApiProperty({ description: 'Received (sku, batch) lines' })
  lineCount!: number;

  @ApiProperty({ description: 'Physical units across all lines' })
  totalUnits!: number;

  @ApiProperty({ description: 'Units applied immediately (the excess pends)' })
  appliedUnits!: number;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

export class GoodsReceiptListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Narrow to one warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

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

export class GoodsReceiptListResponse {
  @ApiProperty({ type: [GoodsReceiptEntryDto] })
  items!: readonly GoodsReceiptEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── over-receipt surfaces ────────────────────────────────────────────────────

/** One over-receipt of the Conflicts & Reviews queue. */
export class OverReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code (server-assigned)' })
  grnCode!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poId!: string | null;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  // The schema floor follows the GRN line it derives from (@Min(0.001)): a
  // sub-1 fractional excess is a real queue item, not a schema violation.
  @ApiProperty({ description: `The excess held for approval. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  excessQty!: number;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] })
  status!: 'pending' | 'approved' | 'rejected';

  @ApiProperty({ format: 'uuid' })
  requestedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  requestedAt!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  decidedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

export class OverReceiptListQuery {
  @ApiProperty({ required: false, enum: ['pending', 'approved', 'rejected'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';

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

export class OverReceiptListResponse {
  @ApiProperty({ type: [OverReceiptDto] })
  items!: readonly OverReceiptDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class OverReceiptDecisionResponse {
  @ApiProperty({ type: OverReceiptDto })
  overReceipt!: OverReceiptDto;
}

// ── device catalog snapshot ──────────────────────────────────────────────────

export class CatalogSnapshotQuery {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the snapshot is scoped to' })
  @IsUUID()
  warehouseId!: string;
}

/** One SKU of the device snapshot's barcode map. */
export class CatalogSnapshotSkuDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  barcode!: string;

  @ApiProperty({ example: 'each', enum: [...UOMS] })
  uom!: string;

  @ApiProperty({
    example: 0,
    minimum: 0,
    maximum: QUANTITY_DECIMALS,
    description:
      'Decimal places this SKU\'s base UoM may express (each = 0, kg = 3). The device validates entry against it OFFLINE, inside the Rejected banner, so a too-precise scan is refused before it is ever queued.',
  })
  uomPrecision!: number;

  @ApiProperty()
  batchTracked!: boolean;

  @ApiProperty()
  serialTracked!: boolean;

  @ApiProperty({
    description:
      'Story 10.3: the SKU is handled by unit and priced by weight. It rides the snapshot so the device can PROMPT for a per-unit weight at receipt while offline — a prompt only the server knows about never happens on the floor.',
  })
  catchWeightTracked!: boolean;
}

/** One open PO of the device snapshot (header + line quantities). */
export class CatalogSnapshotPoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: [PurchaseOrderLineDto], description: 'Per-line ordered / received / open quantities' })
  lines!: readonly PurchaseOrderLineDto[];
}

/** One pack task of the device snapshot (story 10.7, additive) — the bench's unit of work. */
export class CatalogPackTaskDto {
  @ApiProperty({ format: 'uuid', description: 'The fully-picked, still-accepted order' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({
    description:
      'What the order actually had PICKED of this SKU, in base units — from the same grouped-picks read the pack command verifies against. The bench scans to EXACTLY this; a whole count at the bench.',
  })
  pickedQty!: number;

  @ApiProperty({
    description:
      'Story 10.3: the SKU is handled by unit — the bench must scan each case\'s handling-unit label (count == pickedQty), never a typed quantity.',
  })
  catchWeightTracked!: boolean;
}

/** One active handling unit of the device snapshot (story 10.7, additive). */
export class CatalogHandlingUnitDto {
  @ApiProperty({ format: 'uuid', description: 'The unit label the bench scans' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the unit belongs to' })
  skuId!: string;
}

export class CatalogSnapshotResponse {
  @ApiProperty({ description: 'ISO-8601 UTC capture time' })
  generatedAt!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: [CatalogSnapshotSkuDto] })
  skus!: readonly CatalogSnapshotSkuDto[];

  @ApiProperty({ type: [CatalogSnapshotPoDto], description: 'The warehouse\'s open POs with their lines' })
  openPurchaseOrders!: readonly CatalogSnapshotPoDto[];

  @ApiProperty({ type: [PutawayBinDto], description: 'Story 3.5 (additive): every bin of the warehouse — blocked/system bins included so the device can reject a scan against them pre-queue' })
  bins!: readonly PutawayBinDto[];

  @ApiProperty({ type: [PutawayTaskDto], description: 'Story 3.5 (additive): the derived putaway tasks with the capacity-only suggestions (advisory — the server re-gates at placement)' })
  putawayTasks!: readonly PutawayTaskDto[];

  @ApiProperty({ type: [PickTaskDto], description: 'Story 4.3 (additive): the pick tasks of every ready picklist on a released wave, in walk order (the bin/batch each names is advisory — the server re-derives both at pick time)' })
  pickTasks!: readonly PickTaskDto[];

  @ApiProperty({ type: [CatalogPackTaskDto], description: 'Story 10.7 (additive): the packable orders\' per-SKU picked totals — the dataset the bench pre-verifies its scan against, offline. Mirrors the pack command\'s own verification query (picks grouped by (order, sku)) and its completeness guards (accepted, ≥1 pick line, none planned, not all cancelled)' })
  packTasks!: readonly CatalogPackTaskDto[];

  @ApiProperty({ type: [CatalogHandlingUnitDto], description: 'Story 10.7 (additive): every ACTIVE handling unit of the warehouse (id + skuId) — the labels a catch-weight bench scan resolves against, offline. Active-only self-prunes (units flip to packed at pack)' })
  handlingUnits!: readonly CatalogHandlingUnitDto[];
}
