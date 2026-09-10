import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// ── qc-holds.place input ─────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/receiving/qc-holds body (tenant session, `qc.manage`). */
export class PlaceQcHoldDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse holding the stock' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The scope\'s origin bin — captured at hold time; release returns the stock here',
  })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    description:
      'Why the stock is quarantined (free-form, carried verbatim; at most 200 characters)',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  reason!: string;
}

// ── qc-hold responses ────────────────────────────────────────────────────────

/** One QC hold as every surface returns it. */
export class QcHoldDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid', description: 'The origin bin (release returns here)' })
  binId!: string;

  @ApiProperty({ description: 'Why the stock is quarantined (carried verbatim)' })
  reason!: string;

  @ApiProperty({ enum: ['open', 'released'] })
  status!: 'open' | 'released';

  @ApiProperty({ format: 'uuid' })
  heldBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  heldAt!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  releasedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC instant when released; null while the hold is open' })
  releasedAt!: string | null;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

export class QcHoldListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Filter by warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: ['open', 'released'] })
  @IsOptional()
  @IsIn(['open', 'released'])
  status?: 'open' | 'released';

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    required: false,
    example: 50,
    minimum: 1,
    description: 'Page size (values above the 200 ceiling are clamped to it)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class QcHoldListResponse {
  @ApiProperty({ type: [QcHoldDto] })
  items!: readonly QcHoldDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class QcHoldResponse {
  @ApiProperty({ type: QcHoldDto })
  qcHold!: QcHoldDto;
}