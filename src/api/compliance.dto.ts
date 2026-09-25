import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MIN_READING_C, MAX_READING_C } from '../modules/compliance/excursion.command';

// ── excursion record input ───────────────────────────────────────────────────

/** POST /tenants/{tenantId}/excursions body (tenant session, `excursion.record`). */
export class RecordExcursionDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse holding the affected stock' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      "The bin the reading was taken against — the excursion's origin bin and its holds' origin",
  })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    description: 'The operator-captured reading, °C (−100..200, at most two decimal places)',
    minimum: MIN_READING_C,
    maximum: MAX_READING_C,
  })
  @Type(() => Number)
  // maxDecimalPlaces: the column is numeric(6,2) and the docs say two
  // decimals — 8.999 is refused here, not silently rounded to 9 (the
  // command's 2dp normalization stays as the non-DTO backstop).
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_READING_C)
  @Max(MAX_READING_C)
  readingC!: number;

  @ApiProperty({
    required: false,
    nullable: true,
    // Explicit: `string | null` reflects as Object under bun, String under
    // jest — the exported document and the served one must agree.
    type: String,
    description: "The operator's free-text context (at most 200 characters)",
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string | null;

  @ApiProperty({
    required: false,
    description:
      'When the reading was observed (Z-suffixed ISO-8601 UTC); the server clock when absent',
  })
  @IsOptional()
  @IsString()
  occurredAt?: string;
}

// ── excursion responses ──────────────────────────────────────────────────────

/** One excursion as every surface returns it. */
export class ExcursionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The origin bin the reading was taken against' })
  binId!: string;

  @ApiProperty({ description: 'The operator-captured reading, °C' })
  readingC!: number;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: [String], description: 'The QC holds the excursion quarantined its scopes with' })
  holdIds!: string[];

  @ApiProperty({ enum: ['open', 'resolved'] })
  status!: 'open' | 'resolved';

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — when the reading was observed' })
  occurredAt!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  resolvedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC instant when resolved; null while the excursion is open' })
  resolvedAt!: string | null;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

export class ExcursionListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Filter by warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: ['open', 'resolved'] })
  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';

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

export class ExcursionListResponse {
  @ApiProperty({ type: [ExcursionDto] })
  items!: readonly ExcursionDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class ExcursionResponse {
  @ApiProperty({ type: ExcursionDto })
  excursion!: ExcursionDto;
}