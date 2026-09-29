import { Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { COUNT_TASK_ORIGINS, COUNT_VARIANCE_STATUSES } from '../../shared/db/schema';
import { MAX_VARIANCE_THRESHOLD_BASE } from './variance-policy.command';
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

// ── story 5-4 — variance resolution DTOs ─────────────────────────────────────

/** PUT /tenants/{tenantId}/movements/variance-policies body. */
export class SetVariancePolicyDto {
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MAX_VARIANCE_THRESHOLD_BASE,
    description:
      `The |delta| ceiling in BASE units above which a variance resolves by owner only (null/absent = disable the routing). Stored as milli-units. ${QUANTITY_FIELD_DESCRIPTION}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_VARIANCE_THRESHOLD_BASE)
  quantityThreshold?: number | null;
}

/** GET …/movements/variance-policies response (the body, or 404 when unset). */
export class VariancePolicyResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Base units; null = the routing is disabled' })
  quantityThreshold!: number | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

/** One consulted-ledger-seqs list input line: whole seq numbers ≥ 1. */
export class ResolveCountVarianceDto {
  @ApiProperty({ enum: ['approve_adjust', 'recount'], description: 'The resolution arm' })
  @IsIn(['approve_adjust', 'recount'])
  decision!: 'approve_adjust' | 'recount';

  @ApiProperty({
    required: false,
    type: [Number],
    nullable: true,
    description:
      'The ledger seqs this resolution states it consulted (the bin timeline the approver pulled). Required, non-empty, on approve_adjust; optional on recount.',
    minimum: 1,
    maxItems: 200,
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  consideredEventSeqs?: number[] | null;

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

/** GET …/movements/variances query (the 5-5-destined resolution queue). */
export class CountVarianceListQuery {
  @ApiProperty({ required: false, enum: [...COUNT_VARIANCE_STATUSES] })
  @IsOptional()
  @IsIn(COUNT_VARIANCE_STATUSES as unknown as string[])
  status?: (typeof COUNT_VARIANCE_STATUSES)[number];

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

/** One row of GET …/movements/variances. */
export class CountVarianceEntryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Base units — the frozen expectation' })
  expectedQuantity!: number;

  @ApiProperty({ description: 'Base units — what the operator counted' })
  countedQuantity!: number;

  @ApiProperty({ description: 'counted − expected (may be negative)' })
  delta!: number;

  @ApiProperty({ description: 'A movement moved the bin between task start and submit (OQ-2)' })
  epochConflict!: boolean;

  @ApiProperty({ enum: [...COUNT_VARIANCE_STATUSES] })
  status!: string;

  // The explicit `type` on every nullable-optional scalar (the 5-3
  // `SubmitCountResponse.recountTaskId` idiom): jest's transpile emits no
  // design:type metadata, and without it the rendered contract drifts to
  // `object` between the two compilers.
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Base units — the submit-frozen threshold; null = disabled',
  })
  thresholdQuantity!: number | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  resolvedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The recount arm’s minted task' })
  recountTaskId!: string | null;

  @ApiProperty({ nullable: true, type: [Number], description: 'The consulted ledger seqs' })
  consideredEventSeqs!: number[] | null;

  @ApiProperty()
  createdAt!: string;
}

/** POST …/movements/variances/:varianceId/resolve response. */
export class ResolveCountVarianceResponse {
  @ApiProperty({ type: CountVarianceEntryResponseDto })
  variance!: CountVarianceEntryResponseDto;

  @ApiProperty({
    nullable: true,
    description: 'The approve arm’s applied correction (event id + seq + the settled on-hand); null on the recount arm',
  })
  stockCorrection!: {
    eventId: string;
    seq: number | null;
    onHand: { skuId: string; binId: string; quantity: number };
  } | null;
}
