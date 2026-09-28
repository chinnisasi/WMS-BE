import { Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { TRANSFER_STATUSES } from '../../shared/db/schema';
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
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The movements HTTP surface's DTOs (Story 5-1) — class-validator +
 * `@ApiProperty`, the repo's api-shell idiom. Base units at the edge
 * (story 10.1): quantities cross this boundary in the SKU's base UoM and
 * the command converts behind its replay lookup.
 */

// ── transfer.create input ────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/movements/transfers body line. */
export class TransferLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Quantity to move. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;

  @ApiProperty({ format: 'uuid', description: 'The source bin the units draw from (source warehouse)' })
  @IsUUID()
  fromBinId!: string;

  @ApiProperty({ format: 'uuid', description: 'The PLANNED destination bin (destination warehouse)' })
  @IsUUID()
  toBinId!: string;

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

  @ApiProperty({ required: false, type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;
}

/** POST /tenants/{tenantId}/movements/transfers body. */
export class CreateTransferDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the stock leaves' })
  @IsUUID()
  sourceWarehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The warehouse the units land in (MAY equal the source)' })
  @IsUUID()
  destWarehouseId!: string;

  @ApiProperty({ required: false, type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;

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

  @ApiProperty({ type: [TransferLineDto], minItems: 1 })
  @Type(() => TransferLineDto)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  lines!: TransferLineDto[];
}

// ── transfer.confirm-outbound input ─────────────────────────────────────────

/** One line's serial scans at outbound confirm. */
export class ConfirmOutboundLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  lineId!: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 200,
    description: 'The raw serial numbers of a serial-tracked line (one per unit, no duplicates)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];
}

/** POST /tenants/{tenantId}/movements/transfers/{transferId}/outbound-confirm body. */
export class ConfirmOutboundDto {
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

  @ApiProperty({
    required: false,
    type: [ConfirmOutboundLineDto],
    description: 'Per-line serial scans — only for serial-tracked lines',
  })
  @IsOptional()
  @Type(() => ConfirmOutboundLineDto)
  @IsArray()
  @ArrayMaxSize(500)
  lines?: ConfirmOutboundLineDto[];
}

// ── transfer.confirm-inbound input ──────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/movements/transfers/{transferId}/inbound-confirm
 * body — the mobile `transfer.confirm` op's payload shape (plus the op
 * ULID as the Idempotency-Key).
 */
export class ConfirmInboundDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description:
      'The operator\'s SCANNED destination bin — authoritative when carried (redirecting every line), else each line lands in its planned bin',
  })
  @IsOptional()
  @IsUUID()
  destBinId?: string | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    description:
      'The dest bin\'s state epoch the task read captured; null/absent = match, a stale epoch answers 409 transfer-bin-changed',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  binStateEpoch?: number | null;

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

// ── transfer.cancel input ────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/movements/transfers/{transferId}/cancel body. */
export class CancelTransferDto {
  @ApiProperty({ required: false, type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string | null;
}

// ── reads ────────────────────────────────────────────────────────────────────

/** GET .../transfers query. */
export class TransferListQuery {
  @ApiProperty({ required: false, enum: TRANSFER_STATUSES })
  @IsOptional()
  @IsIn(TRANSFER_STATUSES as unknown as string[])
  status?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceWarehouseId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  destWarehouseId?: string;

  @ApiProperty({ required: false, type: String, description: 'Opaque keyset cursor' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, type: Number, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ── response bodies (the idempotency snapshots) ──────────────────────────────

export class TransferLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: `The line quantity. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  quantity!: number;

  @ApiProperty({ format: 'uuid' })
  fromBinId!: string;

  @ApiProperty({ format: 'uuid' })
  toBinId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The catalog batch identity on a batch-tracked line' })
  batchRef!: string | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class TransferOrderResponse {
  @ApiProperty({})
  transfer!: {
    id: string;
    status: string;
    sourceWarehouseId: string;
    destWarehouseId: string;
    note: string | null;
    createdAt: string;
  };

  @ApiProperty({ type: [TransferLineResponseDto] })
  lines!: TransferLineResponseDto[];
}

export class TransferLegEventResponseDto {
  @ApiProperty({ format: 'uuid', description: 'The chain the event sits on' })
  warehouseId!: string;

  @ApiProperty({ type: Number })
  seq!: number;

  @ApiProperty({ description: 'transfer.outbound | transfer.inbound' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: `The event's magnitude. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  quantity!: number;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  fromBinId!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  toBinId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchRef!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serialRef!: string | null;

  @ApiProperty({ description: 'Business time (ISO-8601 UTC)' })
  occurredAt!: string;
}

export class TransferConfirmResponse {
  @ApiProperty({})
  transfer!: { id: string; status: string; confirmedAt: string };

  @ApiProperty({ type: [TransferLegEventResponseDto] })
  events!: TransferLegEventResponseDto[];
}

export class TransferListResponse {
  @ApiProperty({ type: [Object] })
  items!: Record<string, unknown>[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class TransferDetailResponse {
  @ApiProperty({})
  transfer!: Record<string, unknown>;

  @ApiProperty({ type: [Object] })
  lines!: Record<string, unknown>[];

  @ApiProperty({ type: [TransferLegEventResponseDto] })
  events!: TransferLegEventResponseDto[];
}