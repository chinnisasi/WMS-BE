import { Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { COUNT_TASK_ORIGINS } from '../../shared/db/schema';
import { ABC_CLASSES } from '../../shared/primitives/abc-class';
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
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The movements HTTP surface's COUNT DTOs (Story 5-3) — class-validator +
 * `@ApiProperty`, the repo's api-shell idiom. Base units at the edge
 * (story 10.1): counted quantities cross this boundary in the SKU's base
 * UoM and the command converts behind its replay lookup. The `abc_class`
 * vocabulary rides `@IsIn` over the SAME `ABC_CLASSES` tuple the DB CHECK
 * (migration 0045) enumerates — the three mirrored layers.
 */

// ── count.create input ───────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/movements/counts body. */
export class CreateCountDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse holding the bin' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin to count (in that warehouse)' })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    required: false,
    description: 'Business time (ISO-8601 UTC, Z-suffixed); defaults to the commit clock',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  occurredAt?: string;
}

// ── count.submit input ───────────────────────────────────────────────────────

/** One counted line — the mobile `count.submit` op's payload line. */
export class SubmitCountLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `What the operator counted. 0 is a valid count. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  countedQuantity!: number;
}

/**
 * POST /tenants/{tenantId}/movements/counts/{taskId}/submit body — the
 * mobile `count.submit` op's payload shape (plus the op ULID as the
 * Idempotency-Key). EVERY task line must appear here (a line left out is a
 * 400 `count-incomplete`); SKUs found in the bin beyond the task's lines
 * append with an expected of 0.
 */
export class SubmitCountDto {
  @ApiProperty({ type: [SubmitCountLineDto], maxItems: 500 })
  @Type(() => SubmitCountLineDto)
  @IsArray()
  @ArrayMaxSize(500)
  // The nested-validation rule (see `CreateTransferDto.lines` — the pipe
  // does not descend without `@ValidateNested`).
  @ValidateNested({ each: true })
  lines!: SubmitCountLineDto[];

  @ApiProperty({
    required: false,
    description: 'Business time (ISO-8601 UTC, Z-suffixed); defaults to the commit clock',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  occurredAt?: string;
}

// ── count policy upsert input ────────────────────────────────────────────────

/** One row of the warehouse's policy set. */
export class CountPolicyDto {
  @ApiProperty({ enum: ABC_CLASSES })
  @IsIn(ABC_CLASSES as unknown as string[])
  abcClass!: string;

  @ApiProperty({ description: 'Count every due bin of this class at most this often', minimum: 1, maximum: 3650 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  intervalDays!: number;
}

/** PUT /tenants/{tenantId}/movements/warehouses/{warehouseId}/count-policies body. */
export class UpsertCountPoliciesDto {
  @ApiProperty({ type: [CountPolicyDto], maxItems: 3 })
  @Type(() => CountPolicyDto)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  policies!: CountPolicyDto[];

  @ApiProperty({
    required: false,
    description: 'Business time (ISO-8601 UTC, Z-suffixed); defaults to the commit clock',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  occurredAt?: string;
}

// ── response bodies (the idempotency snapshots) ──────────────────────────────

export class CountTaskLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({
    description: `The frozen expectation at task start. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0,
  })
  expectedQuantity!: number;
}

/**
 * The count task of the CREATE response — the id-keyed shape the command's
 * snapshot serves (`id`, not the snapshot card's `taskId`; the card lives in
 * `receiving.dto.ts`'s `CatalogCountTaskDto`, the served class the device
 * snapshot documents).
 */
export class CountTaskResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ enum: COUNT_TASK_ORIGINS })
  origin!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The bin state epoch FROZEN at task start',
  })
  binStateEpoch!: number | null;

  @ApiProperty({ description: 'Business time (ISO-8601 UTC)' })
  createdAt!: string;
}

/**
 * The count task of the SUBMIT response — the settled shape (completion
 * instant + the OQ-2 conflict flag the receipt renders).
 */
export class CountTaskSettledResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ description: 'Business time (ISO-8601 UTC)' })
  completedAt!: string;

  @ApiProperty({ description: 'A movement moved the bin between task start and submit (OQ-2)' })
  epochConflict!: boolean;
}

export class CreateCountResponse {
  @ApiProperty({ type: CountTaskResponseDto })
  countTask!: CountTaskResponseDto;

  @ApiProperty({ type: [CountTaskLineResponseDto] })
  lines!: CountTaskLineResponseDto[];
}

export class CountVarianceResponseDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ minimum: 0 })
  expectedQuantity!: number;

  @ApiProperty({ minimum: 0 })
  countedQuantity!: number;

  @ApiProperty({ description: 'counted − expected (may be negative)' })
  delta!: number;

  @ApiProperty({ description: 'A movement moved the bin between task start and submit (OQ-2)' })
  epochConflict!: boolean;
}

export class SubmitCountResponse {
  @ApiProperty({ type: CountTaskSettledResponseDto })
  countTask!: CountTaskSettledResponseDto;

  @ApiProperty({ type: [CountVarianceResponseDto] })
  variances!: CountVarianceResponseDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The auto-created recount task when the epoch conflicted (OQ-2)',
  })
  recountTaskId!: string | null;
}

export class CountPoliciesResponse {
  @ApiProperty({ type: [CountPolicyDto] })
  policies!: CountPolicyDto[];
}
