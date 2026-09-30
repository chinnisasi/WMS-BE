import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsObject, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import {
  REJECTED_OP_DECISIONS,
  REJECTED_OP_TYPES,
} from '../modules/tenancy/sync-report.command';

/**
 * Rejected sync-report ops HTTP DTOs (story 5-6: `devices/sync-reports` —
 * the replay pass's upload — plus the Conflicts & Reviews queue's
 * `rejected-ops` list + resolve). Validation lives at the boundary; the
 * command layer re-asserts the invariants it owns (per-row shape, the
 * payload's top-level fields, the decision vocabulary).
 */
export class SyncReportAttributionDto {
  @ApiProperty({ required: false, description: "The op's own device label (as sealed at enqueue)" })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  deviceLabel?: string;

  @ApiProperty({ required: false, description: "The op's own operator email (as sealed at enqueue)" })
  @IsOptional()
  @IsString()
  @Length(3, 200)
  operatorEmail?: string;
}

export class SyncReportRowDto {
  @ApiProperty({ description: 'The mobile op\'s ULID (26 chars — the dedupe key)' })
  @IsString()
  @Length(26, 26)
  opId!: string;

  @ApiProperty({ enum: ['grn.submit', 'putaway.place', 'pick.record', 'pack.execute', 'excursion.record', 'transfer.confirm', 'count.submit'] })
  @IsIn(REJECTED_OP_TYPES)
  opType!: (typeof REJECTED_OP_TYPES)[number];

  @ApiProperty({ enum: ['rejected', 'quarantined'], description: 'The replay fate the server refused with' })
  @IsIn(['rejected', 'quarantined'])
  classification!: 'rejected' | 'quarantined';

  @ApiProperty({ description: 'The refusal code, verbatim from the replay' })
  @IsString()
  @Length(1, 200)
  problemCode!: string;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The refusal detail, verbatim (null when the server sent none)' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  problemDetail?: string | null;

  @ApiProperty({ type: Object, description: "The op's payload as enqueued (base units; the apply arm re-executes it)" })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiProperty({ type: SyncReportAttributionDto, nullable: true, required: false, description: "The op's own session as the device sealed it" })
  @IsOptional()
  @IsObject()
  attribution!: SyncReportAttributionDto | null;

  @ApiProperty({ description: 'When the op was enqueued on the device (ISO-8601)' })
  @IsString()
  opEnqueuedAt!: string;

  @ApiProperty({ type: String, nullable: true, required: false, description: "The op's business time when the payload carried one" })
  @IsOptional()
  @IsString()
  opOccurredAt?: string | null;
}

export class RecordSyncReportDto {
  @ApiProperty({ type: [SyncReportRowDto], description: 'The dropped terminal ops retained by the last replay pass(es)', maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SyncReportRowDto)
  rows!: SyncReportRowDto[];
}

export class SyncReportRowAckResponse {
  @ApiProperty({ description: 'The op\'s ULID' })
  opId!: string;

  @ApiProperty({ description: 'Whether this upload recorded the row (false = the (tenant, op_id) dedupe absorbed it)' })
  recorded!: boolean;
}

export class SyncReportResponse {
  @ApiProperty({ description: 'Rows the report carried' })
  received!: number;

  @ApiProperty({ description: 'Rows newly recorded (open in the queue)' })
  recorded!: number;

  @ApiProperty({ description: 'Rows the per-row dedupe absorbed (already reported)' })
  duplicates!: number;

  @ApiProperty({ type: [SyncReportRowAckResponse] })
  rows!: SyncReportRowAckResponse[];
}

export class RejectedOpResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ format: 'uuid' })
  operatorUserId!: string;

  @ApiProperty({ description: "The mobile op's ULID" })
  opId!: string;

  @ApiProperty({ enum: ['grn.submit', 'putaway.place', 'pick.record', 'pack.execute', 'excursion.record', 'transfer.confirm', 'count.submit'] })
  opType!: string;

  @ApiProperty({ enum: ['rejected', 'quarantined'] })
  classification!: string;

  @ApiProperty()
  problemCode!: string;

  @ApiProperty({ type: String, nullable: true })
  problemDetail!: string | null;

  @ApiProperty({ type: Object })
  payload!: Record<string, unknown>;

  @ApiProperty({ type: Object, description: 'Device name + operator id/email + the op\'s own session' })
  attribution!: Record<string, unknown>;

  @ApiProperty()
  opEnqueuedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  opOccurredAt!: string | null;

  @ApiProperty({ enum: ['open', 'applied', 'recounted', 'discarded'] })
  status!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolvedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ type: Object, nullable: true, description: 'The arm\'s outcome (the applied snapshot / minted count task id / the discard marker)' })
  resolvedOutcome!: Record<string, unknown> | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class RejectedOpListQuery {
  @ApiProperty({ required: false, enum: ['open', 'applied', 'recounted', 'discarded'] })
  @IsOptional()
  @IsIn(['open', 'applied', 'recounted', 'discarded'])
  status?: 'open' | 'applied' | 'recounted' | 'discarded';

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  // `@IsNumber` + the bounds make the list's documented 400 arm REACHABLE:
  // `limit=abc` (a NaN past `@Type`) and out-of-range values are boundary
  // 400s naming the query, never a NaN passed down to the command's clamp
  // and on to the database as a 500. The command's own clamp stays as the
  // belt (the direct-surface contract), never the only gate.
  @Type(() => Number)
  @IsNumber({}, { message: 'limit must be a number (the OpenAPI documents minimum 1, maximum 200).' })
  @Min(1, { message: 'limit must be at least 1 (the OpenAPI documents minimum 1, maximum 200).' })
  @Max(200, { message: 'limit must be at most 200 (the OpenAPI documents minimum 1, maximum 200).' })
  limit?: number;
}

export class RejectedOpListResponse {
  @ApiProperty({ type: [RejectedOpResponse] })
  items!: RejectedOpResponse[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class ResolveRejectedOpDto {
  @ApiProperty({ enum: ['apply', 'recount', 'discard'], description: "The arm — 'recount' requires the payload to carry a bin" })
  @IsIn(REJECTED_OP_DECISIONS)
  decision!: (typeof REJECTED_OP_DECISIONS)[number];

  @ApiProperty({ required: false, description: 'The decision instant (ISO-8601 UTC; server clock when absent)' })
  @IsOptional()
  @IsString()
  occurredAt?: string;
}

export class RejectedOpResolveResponse {
  @ApiProperty({ type: RejectedOpResponse })
  rejectedOp!: RejectedOpResponse;

  @ApiProperty({ type: Object, nullable: true, description: "The arm's outcome — the re-executed command's snapshot, the minted count task id, or the discard marker" })
  outcome!: Record<string, unknown> | null;
}
