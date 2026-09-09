import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

/** Trim at the validation boundary (the tenancy DTO pattern). */
function Trim() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Transform(({ value }: { value: any }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

/** Trim every array element at the validation boundary (Story 2.4 serials). */
function TrimEach() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Transform(({ value }: { value: any }) =>
    Array.isArray(value)
      ? value.map((element) => (typeof element === 'string' ? element.trim() : element))
      : value,
  );
}

/**
 * Story 2.4 batch input (additive): the batch's identity for an intake
 * (`code` + optional mfg/expiry), or the explicit batch of an override draw
 * — which then REQUIRES `overrideReason` (the FEFO default draw omits the
 * field entirely).
 */
export class BatchInputDto {
  @ApiProperty({
    description: 'Batch code — unique per tenant + SKU; ensured idempotently on intake',
    minLength: 1,
    maxLength: 64,
  })
  @Trim()
  @IsString()
  @Length(1, 64)
  code!: string;

  @ApiProperty({
    required: false,
    description: 'Manufacturing date (ISO-8601 UTC, Z-suffixed); recorded at intake',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  mfgDate?: string;

  @ApiProperty({
    required: false,
    description: 'Expiry date (ISO-8601 UTC, Z-suffixed); optional at intake, orders FEFO (nulls last)',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  expiryDate?: string;

  @ApiProperty({
    required: false,
    description:
      'Required when a draw names an explicit batch instead of the FEFO default — recorded verbatim in the ledger reference doc',
    minLength: 1,
    maxLength: 200,
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  overrideReason?: string;
}

/**
 * `stock.adjustment` command body (Story 2.1): a signed base-UoM delta on
 * one bin of one SKU, with a typed reason. Zero deltas are rejected — a
 * movement of nothing is not a movement (400 `validation-failed`).
 *
 * Story 2.4 additive arms: `batch` (batch-tracked movements — required on
 * intake, FEFO-defaulted or explicit on a draw) and `serials` (serial-tracked
 * movements — exactly one ledger event per serial unit, so the count must
 * equal the delta's magnitude). Both omitted on a flagless SKU: the request
 * shape and behavior are byte-identical to the pre-2.4 adjustment.
 */
export class StockAdjustmentDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse holding the bin' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  binId!: string;

  @ApiProperty({ description: 'Signed base-UoM integer; positive into the bin, negative out' })
  @Type(() => Number)
  @IsInt()
  @Min(-2147483648)
  @Max(2147483647)
  quantityDelta!: number;

  @ApiProperty({ description: 'Machine reason for the correction (e.g. stock-count)' })
  @Trim()
  @IsString()
  @Length(1, 64)
  reasonCode!: string;

  @ApiProperty({ description: "The Ops Manager's note, carried verbatim on the event" })
  @Trim()
  @IsString()
  @Length(1, 500)
  note!: string;

  @ApiProperty({
    required: false,
    description: 'Business time (ISO-8601 UTC, Z-suffixed); defaults to the commit clock',
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  occurredAt?: string;

  @ApiProperty({
    required: false,
    type: BatchInputDto,
    description:
      'Batch arm (batch-tracked SKUs only): intake identity, or the explicit override draw (with overrideReason)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BatchInputDto)
  batch?: BatchInputDto;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 1000,
    description:
      'Serial arm (serial-tracked SKUs only): one serial number per unit — quantityDelta must equal the count',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  // Trimmed per element BEFORE the length validation: a whitespace-only
  // serial trims to '' and fails `Length(1, 64)` as a 400 (review loop 1 —
  // it must never reach identity creation as an empty serial number).
  @TrimEach()
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];
}

/** Query for the event-timeline read (keyset cursor pagination). */
export class LedgerEventsQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Only events of one SKU' })
  @IsOptional()
  @IsUUID()
  skuId?: string;

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

/** One settled on-hand scope in the adjustment response. */
export class OnHandSnapshotDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ description: 'On-hand in base UoM after the movement' })
  quantity!: number;
}

/** The appended ledger event as the API returns it (the snapshot). */
export class LedgerEventSnapshotDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Gap-free per-warehouse replay order' })
  seq!: number;

  @ApiProperty({ example: 'stock.adjusted' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  binId!: string | null;

  @ApiProperty({ description: 'Signed base-UoM delta' })
  quantityDelta!: number;

  @ApiProperty({ description: 'ISO-8601 UTC business time' })
  occurredAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC commit time' })
  recordedAt!: string;
}

/** POST …/inventory/adjustments response body (the idempotency snapshot). */
export class StockAdjustmentResponse {
  @ApiProperty({ type: LedgerEventSnapshotDto })
  event!: LedgerEventSnapshotDto;

  @ApiProperty({ type: OnHandSnapshotDto })
  onHand!: OnHandSnapshotDto;
}

/** One event-timeline row. */
export class LedgerEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  seq!: number;

  @ApiProperty({ example: 'stock.adjusted' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  fromBinId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toBinId!: string | null;

  @ApiProperty()
  quantityDelta!: number;

  @ApiProperty({ format: 'uuid' })
  actorUserId!: string;

  @ApiProperty()
  occurredAt!: string;

  @ApiProperty()
  recordedAt!: string;

  @ApiProperty({ description: 'sha256 over the canonical event bytes (chain link)' })
  eventHash!: string;

  @ApiProperty({ description: 'ISO-8601 UTC commit time of the append' })
  createdAt!: string;
}

/** GET …/warehouses/{warehouseId}/inventory/events response. */
export class LedgerEventListResponse {
  @ApiProperty({ type: [LedgerEventDto] })
  items!: readonly LedgerEventDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}