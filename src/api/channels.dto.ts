import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsObject, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { MAX_QUANTITY_MILLI } from '../shared/primitives/quantity';
import { BACKORDER_POLICIES, CHANNEL_PROVIDERS } from '../shared/db/schema';
import type {
  ChannelConnectionView,
  ChannelConnectionListEntry,
  ChannelBufferVerdict,
} from '../modules/channels/channels.view';

/**
 * The channels HTTP surface's bodies (story 7.1). The connect/rotate
 * bodies are WRITE-ONLY: `credentials` validates as an object and is
 * sealed by the command — the response DTOs never carry it.
 */

export class ConnectChannelDto {
  @ApiProperty({ enum: CHANNEL_PROVIDERS, description: 'The channel provider to connect' })
  @IsIn(CHANNEL_PROVIDERS)
  provider!: string;

  @ApiProperty({
    description:
      'Provider-shaped credential material (the fields the registry declares for the provider — sealed under CHANNEL_ENCRYPTION_KEY and never returned)',
    type: Object,
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  credentials!: Record<string, unknown>;
}

export class RotateChannelCredentialDto {
  @ApiProperty({
    description:
      'The rotated provider-shaped credential material (sealed in place; version bumped) — never returned',
    type: Object,
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  credentials!: Record<string, unknown>;
}

export class UpdateConnectionConfigDto {
  @ApiProperty({ enum: BACKORDER_POLICIES, description: "The channel's backorder policy (consumed by 7-2's ingestion acceptance)" })
  @IsIn(BACKORDER_POLICIES)
  backorderPolicy!: string;
}

export class ChannelBufferItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: 'Safety buffer in MILLI-units (base UoM × 10³) — the standing reservation target (0 clears it)',
    minimum: 0,
    maximum: MAX_QUANTITY_MILLI,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_QUANTITY_MILLI)
  bufferMilli!: number;
}

export class SetChannelBuffersDto {
  @ApiProperty({ type: [ChannelBufferItemDto], description: 'Buffer rows to place/adjust (≤ 200 per request)' })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ChannelBufferItemDto)
  items!: ChannelBufferItemDto[];
}

// ── responses ───────────────────────────────────────────────────────────────

/** One connection's public face — NEVER credential material. */
export class ChannelConnectionResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;
  @ApiProperty()
  provider!: string;
  @ApiProperty()
  providerName!: string;
  @ApiProperty({ enum: ['connected'] })
  status!: string;
  @ApiProperty({ enum: BACKORDER_POLICIES })
  backorderPolicy!: string;
  @ApiProperty()
  credentialVersion!: number;
  @ApiProperty({ format: 'uuid' })
  connectedBy!: string;
  // `type` is load-bearing on the nullable fields (the carriers precedent):
  // tsc's decorator metadata for a `string | null` union is `String` under
  // jest but `Object` under swc — pinning the type keeps the served document
  // and the openapi:export commit identical (the api.spec.ts drift guard).
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  rotatedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  rotatedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastSyncedAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;
  @ApiProperty({ enum: ['closed', 'open', 'half-open'] })
  breakerState!: string;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class ChannelConnectionListResponse {
  @ApiProperty({ type: [ChannelConnectionResponse] })
  items!: ChannelConnectionResponse[];
  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

/** The per-connection sync-health row (arm 4). */
export class ChannelConnectionListEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  provider!: string;
  @ApiProperty()
  providerName!: string;
  @ApiProperty()
  status!: string;
  @ApiProperty({ enum: BACKORDER_POLICIES })
  backorderPolicy!: string;
  @ApiProperty()
  credentialVersion!: number;
  @ApiProperty({ enum: ['ok', 'degraded', 'error'] })
  health!: string;
  // Same load-bearing `type` pins (union reflection, see above).
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastSyncedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  syncLagMs!: number | null;
  @ApiProperty({ enum: ['closed', 'open', 'half-open'] })
  breakerState!: string;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
  @ApiProperty({ type: [Object], description: 'The standing buffer buckets: {warehouseId, skuId, bufferMilli}' })
  buffers!: { warehouseId: string; skuId: string; bufferMilli: number }[];
  @ApiProperty()
  mappingCount!: number;
}

export class ChannelConnectionsResponse {
  @ApiProperty({ type: [ChannelConnectionListEntryDto] })
  items!: ChannelConnectionListEntryDto[];
}

export class ChannelBufferVerdictDto {
  @ApiProperty()
  index!: number;
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;
  @ApiProperty({ format: 'uuid' })
  skuId!: string;
  @ApiProperty({ enum: ['applied', 'unchanged', 'refused'] })
  status!: string;
  @ApiProperty()
  bufferMilli!: number;
  @ApiProperty()
  standingMilli!: number;
  @ApiProperty({ required: false, enum: ['buffer-over-ceiling'] })
  code?: 'buffer-over-ceiling';
  @ApiProperty({ required: false })
  detail?: string;
}

export class ChannelBuffersSetResponse {
  @ApiProperty({ format: 'uuid' })
  connectionId!: string;
  @ApiProperty({ type: [ChannelBufferVerdictDto] })
  verdicts!: ChannelBufferVerdictDto[];
}

/** Channel uuid path params / views ride these shims. */
export function toConnectionResponse(connection: ChannelConnectionView): ChannelConnectionResponse {
  return { ...connection };
}

export function toListEntryResponse(entry: ChannelConnectionListEntry): ChannelConnectionListEntryDto {
  return { ...entry, buffers: [...entry.buffers] };
}

export function toVerdictResponses(verdicts: readonly ChannelBufferVerdict[]): ChannelBufferVerdictDto[] {
  return verdicts.map((verdict) => ({
    index: verdict.index,
    warehouseId: verdict.warehouseId,
    skuId: verdict.skuId,
    status: verdict.status,
    bufferMilli: verdict.bufferMilli,
    standingMilli: verdict.standingMilli,
    ...(verdict.code === undefined ? {} : { code: verdict.code }),
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
  }));
}