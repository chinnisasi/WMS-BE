import { Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { COUNT_TASK_ORIGINS, COUNT_TASK_STATUSES, COUNT_VARIANCE_STATUSES } from '../../shared/db/schema';
import { MAX_VARIANCE_THRESHOLD_BASE } from './variance-policy.command';
import { BULK_COUNT_SKIP_REASONS, MAX_BULK_COUNT_BINS } from './count.command';
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

/**
 * POST /tenants/{tenantId}/movements/counts body. Exactly one of `binId`
 * (the single-bin create — its response, refusals and fingerprint are
 * unchanged), `binIds` or `zoneId` (story 3-5a — the bulk create).
 */
export class CreateCountDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse holding the bin(s)' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'The single bin to count (in that warehouse). Exactly one of binId, binIds, zoneId',
  })
  @IsOptional()
  @IsUUID()
  binId?: string;

  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_BULK_COUNT_BINS,
    uniqueItems: true,
    description:
      'Story 3-5a — count many bins at once (1–500, each named once). A bin with an open task, a system bin and a retired bin are skipped and listed; more than 500 is 400 validation-failed (a zone over 500 is 422 too-many-bins)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BULK_COUNT_BINS)
  @IsUUID('all', { each: true })
  binIds?: string[];

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      "Story 3-5a — count every non-system, non-retired bin of one zone (at most 500; more is 422 too-many-bins). Bins with an open task are skipped and listed",
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

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

/** Story 3-5a — one created task of a bulk create (no quantities). */
export class BulkCreatedCountTaskDto {
  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ description: 'How many SKU lines the task froze', minimum: 0 })
  lineCount!: number;
}

/** Story 3-5a — one bin a bulk create passed over, and why. */
export class BulkSkippedCountBinDto {
  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({
    enum: [...BULK_COUNT_SKIP_REASONS],
    description: 'count-task-open: the bin already has a pending count; system-bin / bin-retired: a listed bin that cannot be counted',
  })
  reason!: (typeof BULK_COUNT_SKIP_REASONS)[number];
}

/** Story 3-5a — the bulk create's response (and its idempotency snapshot). */
export class CreateCountsBulkResponse {
  @ApiProperty({ type: [BulkCreatedCountTaskDto], description: 'One on-demand task per eligible bin — NOT pushed to handhelds' })
  created!: BulkCreatedCountTaskDto[];

  @ApiProperty({ type: [BulkSkippedCountBinDto] })
  skipped!: BulkSkippedCountBinDto[];
}

/**
 * The submit response. Story 3-5a — BLIND: `variances` is always empty and
 * no field carries an expected quantity, a delta or which SKUs differed (the
 * route is shared with the handheld and its stored answer is replayed to
 * whoever retries). The web reads the variance rows through
 * `GET …/movements/counts/{taskId}`.
 */
export class SubmitCountResponse {
  @ApiProperty({ type: CountTaskSettledResponseDto })
  countTask!: CountTaskSettledResponseDto;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', properties: {}, additionalProperties: false },
    maxItems: 0,
    description:
      'Always empty (story 3-5a — counts are blind; a key stored before 3-5a is re-projected on replay). Read variances through the task detail on the web',
  })
  variances!: never[];

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

// ── story 3-5a — the web count-admin reads ───────────────────────────────────

/** GET …/movements/counts query. */
export class CountTaskListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Narrow to one warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: [...COUNT_TASK_STATUSES] })
  @IsOptional()
  @IsIn(COUNT_TASK_STATUSES as unknown as string[])
  status?: (typeof COUNT_TASK_STATUSES)[number];

  @ApiProperty({ required: false, enum: [...COUNT_TASK_ORIGINS] })
  @IsOptional()
  @IsIn(COUNT_TASK_ORIGINS as unknown as string[])
  origin?: (typeof COUNT_TASK_ORIGINS)[number];

  @ApiProperty({ required: false, format: 'uuid', description: 'Narrow to one bin' })
  @IsOptional()
  @IsUUID()
  binId?: string;

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

/** One row of GET …/movements/counts (no quantities). */
export class CountTaskListEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ enum: [...COUNT_TASK_STATUSES] })
  status!: (typeof COUNT_TASK_STATUSES)[number];

  @ApiProperty({ enum: [...COUNT_TASK_ORIGINS] })
  origin!: (typeof COUNT_TASK_ORIGINS)[number];

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The planner; null = the system (scheduler or a recount)' })
  createdBy!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  completedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  completedAt!: string | null;

  @ApiProperty({ minimum: 0 })
  lineCount!: number;

  @ApiProperty({ minimum: 0 })
  varianceCount!: number;

  @ApiProperty({ minimum: 0 })
  openVarianceCount!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Story 3-5b — the stock take this task counts for; null = a cycle count (only a cycle count can be cancelled)' })
  stockTakeId!: string | null;
}

export class CountTaskListResponse {
  @ApiProperty({ type: [CountTaskListEntryDto] })
  items!: readonly CountTaskListEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class CountTaskDetailTaskDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ enum: [...COUNT_TASK_STATUSES] })
  status!: (typeof COUNT_TASK_STATUSES)[number];

  @ApiProperty({ enum: [...COUNT_TASK_ORIGINS] })
  origin!: (typeof COUNT_TASK_ORIGINS)[number];

  @ApiProperty({ type: Number, nullable: true, description: 'The bin state epoch frozen at task start' })
  binStateEpoch!: number | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  createdBy!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  completedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  completedAt!: string | null;

  @ApiProperty({ description: 'A movement moved the bin between task start and submit (OQ-2) — the submit minted a recount; false while pending' })
  epochConflict!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Story 3-5b — the stock take this task counts for; null = a cycle count' })
  stockTakeId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Story 3-5b — who cancelled it (null unless cancelled)' })
  cancelledBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Story 3-5b — when it was cancelled (null unless cancelled)' })
  cancelledAt!: string | null;
}

/** Story 3-5b — POST …/movements/counts/{taskId}/cancel answer. */
export class CancelledCountTaskDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['cancelled'] })
  status!: 'cancelled';

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ format: 'uuid' })
  cancelledBy!: string;

  @ApiProperty()
  cancelledAt!: string;
}

export class CancelCountTaskResponse {
  @ApiProperty({ type: CancelledCountTaskDto })
  countTask!: CancelledCountTaskDto;
}

export class CountTaskDetailLineDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty({ description: `Frozen at task start (0 for a SKU found at submit). ${QUANTITY_FIELD_DESCRIPTION}` })
  expectedQuantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'What the operator counted; null while the task is pending' })
  countedQuantity!: number | null;
}

export class CountTaskDetailVarianceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Base units — what the count was compared against (a recount resolution rewrites it)' })
  expectedQuantity!: number;

  @ApiProperty({ description: 'Base units — what the operator counted' })
  countedQuantity!: number;

  @ApiProperty({ description: 'counted − expected (may be negative)' })
  delta!: number;

  @ApiProperty({ description: 'A movement moved the bin between task start and submit (OQ-2)' })
  epochConflict!: boolean;

  @ApiProperty({ enum: [...COUNT_VARIANCE_STATUSES] })
  status!: (typeof COUNT_VARIANCE_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The recount task a recount resolution minted' })
  recountTaskId!: string | null;
}

/** GET …/movements/counts/{taskId} — expected beside counted (web staff only). */
export class CountTaskDetailResponse {
  @ApiProperty({ type: CountTaskDetailTaskDto })
  task!: CountTaskDetailTaskDto;

  @ApiProperty({ type: [CountTaskDetailLineDto] })
  lines!: CountTaskDetailLineDto[];

  @ApiProperty({ type: [CountTaskDetailVarianceDto] })
  variances!: CountTaskDetailVarianceDto[];

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The recount task a variance of this task names (the latest); null when none' })
  recountTaskId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The recount task the submit minted on an epoch conflict (OQ-2); null when none' })
  conflictRecountTaskId!: string | null;
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
  // The milli-units conversion (`thresholdToMilli`) multiplies by QUANTITY_SCALE —
  // a fractional BASE-unit threshold would invent milli-units the stored
  // integer column cannot carry, and the command refuses non-whole input
  // anyway (the 5-2 `AdjustmentPolicyDto` note); refusing here names the
  // field in the 400 instead of a 500 from the overflow assert.
  @IsInt()
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
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only variances of one client's SKUs. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

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
  status!: (typeof COUNT_VARIANCE_STATUSES)[number];

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

  @ApiProperty({
    description:
      'Story 9-3a — true only when an approve-adjust resolution from 9-3a on posted this variance\'s correction (the row recorded the event): it is listed by `GET …/inventory/events?countVarianceId=`. False while open, on a recount, and for a resolution before 9-3a',
  })
  ledgerLinked!: boolean;

  @ApiProperty()
  createdAt!: string;
}

/** GET …/movements/variances response (the 5-5-destined resolution queue). */
export class CountVarianceListResponse {
  @ApiProperty({ type: [CountVarianceEntryResponseDto] })
  items!: readonly CountVarianceEntryResponseDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
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
