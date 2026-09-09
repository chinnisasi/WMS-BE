import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PurchaseOrderLineDto } from './inbound.dto';

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

  @ApiProperty({ description: 'Physically received quantity in base UoM (positive integer)', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
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

  @ApiProperty({ description: 'Physical truth: everything that arrived', minimum: 1 })
  qty!: number;

  @ApiProperty({ description: 'The within-open portion applied immediately', minimum: 0 })
  appliedQty!: number;

  @ApiProperty({ description: 'The excess pended for approval', minimum: 0 })
  excessQty!: number;
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

  @ApiProperty({ description: 'The excess held for approval (positive integer)', minimum: 1 })
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

  @ApiProperty()
  uom!: string;

  @ApiProperty()
  batchTracked!: boolean;

  @ApiProperty()
  serialTracked!: boolean;
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

export class CatalogSnapshotResponse {
  @ApiProperty({ description: 'ISO-8601 UTC capture time' })
  generatedAt!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: [CatalogSnapshotSkuDto] })
  skus!: readonly CatalogSnapshotSkuDto[];

  @ApiProperty({ type: [CatalogSnapshotPoDto], description: 'The warehouse\'s open POs with their lines' })
  openPurchaseOrders!: readonly CatalogSnapshotPoDto[];
}