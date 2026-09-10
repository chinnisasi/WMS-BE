import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** The fixed mismatch-reason enum (the I/O matrix — 400 outside it). */
export const PUTAWAY_MISMATCH_REASON_ENUM = [
  'pallet-too-heavy',
  'suggested-bin-occupied',
  'consolidation-with-existing-stock',
  'operator-preference',
  'other',
] as const;

// ── putaway.place input ──────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/putaway/placements body (device session, `putaway.execute`). */
export class PlacePutawayDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the placement lands in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The GRN whose received stock is being put away' })
  @IsUUID()
  grnId!: string;

  @ApiProperty({ format: 'uuid', description: 'The GRN line this placement moves' })
  @IsUUID()
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'Catalog batch identity (required for batch-tracked SKUs, forbidden otherwise)',
  })
  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @ApiProperty({
    description: 'Placed quantity in base UoM (positive integer — partial placements allowed)',
    minimum: 1,
    maximum: 2147483647,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  qty!: number;

  @ApiProperty({ format: 'uuid', description: 'The target bin the operator scanned/entered' })
  @IsUUID()
  toBinId!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: PUTAWAY_MISMATCH_REASON_ENUM,
    description: 'The mismatch reason (required when the target bin differs from the suggested bin)',
  })
  @IsOptional()
  @IsIn(PUTAWAY_MISMATCH_REASON_ENUM as unknown as string[])
  reasonCode?: string | null;

  @ApiProperty({ description: 'Device time of the placement (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 200,
    description: 'The serial numbers of a serial-tracked placement (one per unit, no duplicates)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];
}

// ── putaway placement responses ──────────────────────────────────────────────

/** One placement as every surface returns it. */
export class PutawayPlacementDto {
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

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'The SKU code (joined for the report surface)' })
  skuCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The catalog batch code; null on non-batch-tracked SKUs' })
  batchCode!: string | null;

  @ApiProperty({ description: 'The placed quantity (positive integer)', minimum: 1 })
  qty!: number;

  @ApiProperty({ format: 'uuid', description: 'The system Receiving bin the units left' })
  fromBinId!: string;

  @ApiProperty({ format: 'uuid', description: 'The target bin the operator placed into' })
  toBinId!: string;

  @ApiProperty({ description: 'The target bin code' })
  toBinCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'The server\'s re-derived suggestion; null when no bin fit' })
  suggestedBinId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The suggested bin\'s code; null when no bin fit' })
  suggestedBinCode!: string | null;

  @ApiProperty({ enum: PUTAWAY_MISMATCH_REASON_ENUM, type: String, nullable: true, description: 'The recorded mismatch reason; null when the suggestion was followed' })
  reasonCode!: string | null;

  @ApiProperty({ format: 'uuid' })
  placedBy!: string;

  @ApiProperty({ description: 'Device time of the placement (AD-1), ISO-8601 UTC' })
  placedAt!: string;

  @ApiProperty({ format: 'uuid', description: 'The floor device that recorded the placement' })
  deviceId!: string;

  @ApiProperty({ description: 'Row creation time, ISO-8601 UTC' })
  createdAt!: string;
}

export class PutawayPlacementResponse {
  @ApiProperty({ type: PutawayPlacementDto })
  placement!: PutawayPlacementDto;
}

export class PutawayPlacementListQuery {
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

export class PutawayPlacementListResponse {
  @ApiProperty({ type: [PutawayPlacementDto] })
  items!: readonly PutawayPlacementDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── derived tasks + snapshot bins ────────────────────────────────────────────

/** The suggestion's bin reference (the snapshot shape). */
export class SuggestedBinDto {
  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;
}

/** One derived putaway task of the tasks read / device snapshot. */
export class PutawayTaskDto {
  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code (server-assigned)' })
  grnCode!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'min(applied, receiving-bin on-hand) — the placeable units', minimum: 1 })
  qty!: number;

  @ApiProperty({ type: SuggestedBinDto, nullable: true, description: 'The suggested bin; null when no storage bin has room' })
  suggestedBin!: SuggestedBinDto | null;

  @ApiProperty({ description: 'The one-line capacity-only rationale' })
  rationale!: string;
}

export class PutawayTaskListQuery {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the tasks are derived for' })
  @IsUUID()
  warehouseId!: string;
}

export class PutawayTaskListResponse {
  @ApiProperty({ type: [PutawayTaskDto] })
  items!: readonly PutawayTaskDto[];
}

/** One bin of the device snapshot's bins payload (blocked/system bins included). */
export class PutawayBinDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty()
  zoneCode!: string;

  @ApiProperty({ description: 'The fixed bin type (shelf/pallet/floor/staging)' })
  type!: string;

  @ApiProperty({ description: 'Capacity in base-UoM units' })
  capacity!: number;

  @ApiProperty({ description: 'Broken-bin flag — blocked bins reject placements' })
  blocked!: boolean;

  @ApiProperty({ description: 'System bins (Receiving/QC-hold) are never placement targets' })
  systemOwned!: boolean;
}