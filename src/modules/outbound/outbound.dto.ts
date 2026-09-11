import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ORDER_SOURCES } from './order.command';
import {
  PICKLIST_LINE_STATUSES,
  PICKLIST_STATUSES,
  WAVE_GROUPINGS,
  WAVE_STATUSES,
} from './wave.command';

/** Trim at the validation boundary (the tenancy DTO pattern). */
function Trim() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Transform(({ value }: { value: any }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

// ── Order inputs (Story 4.1) ────────────────────────────────────────────────

/** One order line as the client supplies it (manual entry and ingestion alike). */
export class OrderLineInputDto {
  @ApiProperty({ format: 'uuid', description: 'The ordered SKU' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: 'Ordered quantity in base UoM — a positive integer',
    minimum: 1,
    maximum: 2147483647,
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity!: number;
}

/** POST /tenants/{tenantId}/outbound/orders body (manual entry + ingestion). */
export class CreateOrderDto {
  @ApiProperty({ format: 'uuid', description: 'The ordering warehouse' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    default: 'manual',
    enum: [...ORDER_SOURCES],
    description: "'manual' (client entry) or 'ingested' (a channel adapter's delivery)",
  })
  @IsOptional()
  @IsIn([...ORDER_SOURCES])
  source?: 'manual' | 'ingested';

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: "The channel's integration id — required together with externalEventId on an ingested order",
  })
  @IsOptional()
  @IsUUID()
  integrationId?: string;

  @ApiProperty({
    required: false,
    description: "The channel's external event id — the dedup ref (≤200 chars)",
    maxLength: 200,
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  externalEventId?: string;

  @ApiProperty({ type: [OrderLineInputDto], minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];
}

/** POST /tenants/{tenantId}/outbound/orders/{orderId}/cancel body — none. */
export class CancelOrderDto {}

// ── Order responses ─────────────────────────────────────────────────────────

/** One order line of every order response — the shortfall always derived. */
export class OrderLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Ordered quantity (base UoM)' })
  qty!: number;

  @ApiProperty({ description: 'Units acceptance actually holds through the reservation journal (≤ qty)' })
  reservedQty!: number;

  @ApiProperty({ description: 'Derived shortfall (qty − reservedQty) — the backorder remainder' })
  shortfallQty!: number;

  @ApiProperty({ description: "'open' when fully reserved, 'backordered' when any part is short", enum: ['open', 'backordered'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The line’s journal hold (null when nothing could be reserved)' })
  reservationId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The hold’s live journal state (held / released / committed / expired)' })
  reservationState!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;
}

/** One order row of every order response (detail carries the lines). */
export class OrderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: "'accepted' or 'cancelled'", enum: ['accepted', 'cancelled'] })
  status!: string;

  @ApiProperty({ description: "'manual' or 'ingested'", enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Channel integration (null on a manual order)' })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Channel external event id (null on a manual order)' })
  externalEventId!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [OrderLineDto] })
  lines!: readonly OrderLineDto[];
}

export class OrderResponse {
  @ApiProperty({ type: OrderDto })
  order!: OrderDto;
}

/** Query of the warehouse-scoped order list (keyset cursor pagination). */
export class OrderListQuery {
  @ApiProperty({
    required: false,
    description: 'Opaque keyset cursor from the previous page',
    // A cursor encodes one timestamp + one uuid — anything near this bound is
    // crafted input, rejected at the boundary before the base64 decode.
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** One header row of the order list (no lines — the detail read carries them). */
export class OrderEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: ['accepted', 'cancelled'] })
  status!: string;

  @ApiProperty({ enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class OrderListResponse {
  @ApiProperty({ type: [OrderEntryDto] })
  items!: readonly OrderEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── Wave inputs (Story 4.2) ─────────────────────────────────────────────────

/** POST /tenants/{tenantId}/outbound/wave-policies body. */
export class CreateWavePolicyDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the policy waves in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: 'Policy name — unique per warehouse', maxLength: 120 })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({
    enum: [...WAVE_GROUPINGS],
    description:
      "'single' — one picklist per order; 'batch' — ONE picklist across the wave's orders, grouped by bin so each bin is visited once",
  })
  @IsIn([...WAVE_GROUPINGS])
  grouping!: 'single' | 'batch';

  @ApiProperty({ required: false, default: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 500,
    description: 'Cap on the orders one wave draws (absent = the server default, 200)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxOrders?: number;

  @ApiProperty({
    required: false,
    description:
      'Carrier cutoff as a 24-hour HH:MM wall clock in Asia/Kolkata. It gates RELEASE, never generation — planning ahead of a cutoff is the point. Absent = release is always allowed. 00:00 is rejected: it would refuse release for the whole day.',
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    example: '16:00',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'cutoffLocalTime must be a 24-hour HH:MM wall clock',
  })
  // Midnight is the one shape the regex accepts that can never be useful:
  // the cutoff compares "is the local wall clock past HH:MM", which is true
  // at every instant of the day except that exact minute — the policy would
  // refuse release all day, every day. Omit the field to mean "no cutoff".
  @Matches(/^(?!00:00$)/, {
    message:
      'cutoffLocalTime 00:00 would refuse release for the whole day — omit the field for no cutoff',
  })
  cutoffLocalTime?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Carrier reference — shape-validated only: there is no carriers table until story 4.6 / Epic 7, so nothing yet proves the id names a real carrier',
  })
  @IsOptional()
  @IsUUID()
  carrierRef?: string;
}

/** POST /tenants/{tenantId}/outbound/waves body. */
export class GenerateWaveDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse being waved' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The wave policy this wave is generated under' })
  @IsUUID()
  policyId!: string;

  @ApiProperty({
    required: false,
    type: [String],
    minItems: 1,
    maxItems: 500,
    description:
      'Explicit order selection. Absent = every eligible accepted order in the warehouse, oldest first, capped by the policy.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  orderIds?: string[];
}

// ── Wave responses ──────────────────────────────────────────────────────────

export class WavePolicyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: [...WAVE_GROUPINGS] })
  grouping!: string;

  @ApiProperty()
  priority!: number;

  @ApiProperty({ type: Number, nullable: true })
  maxOrders!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'HH:MM wall clock, or null' })
  cutoffLocalTime!: string | null;

  @ApiProperty({ description: 'The IANA zone the cutoff is compared in', example: 'Asia/Kolkata' })
  cutoffTimezone!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Unvalidated carrier ref (4.6)' })
  carrierRef!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class WavePolicyResponse {
  @ApiProperty({ type: WavePolicyDto })
  policy!: WavePolicyDto;
}

export class WavePolicyListResponse {
  @ApiProperty({ type: [WavePolicyDto] })
  items!: readonly WavePolicyDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

/** One pick line — a bin/batch SUGGESTION re-derived at pick time (4.3). */
export class PicklistLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Suggested bin; null when unfulfillable' })
  binId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The suggested bin’s code — the walk key' })
  binCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Suggested batch (FEFO within the bin); null when the SKU carries no batch stock' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The order line’s journal hold, carried forward — never re-reserved here' })
  reservationId!: string | null;

  @ApiProperty({ description: 'Units to draw at this bin (0 on an unfulfillable slice) — always from the order line’s reservedQty, never its qty' })
  qty!: number;

  @ApiProperty({ description: 'Uncovered units — non-zero only on an unfulfillable slice' })
  shortfallQty!: number;

  @ApiProperty({ description: 'The order line’s slice index (an order line may span bins)' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Position on the walk (bins.code ascending)' })
  walkSeq!: number;

  @ApiProperty({ enum: [...PICKLIST_LINE_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;
}

export class PicklistDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The single order served; null on a batch picklist' })
  orderId!: string | null;

  @ApiProperty({ enum: [...PICKLIST_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'Distinct bin stops on this walk — the "steps" of the batching guarantee' })
  stopCount!: number;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [PicklistLineDto], description: 'Pick lines in walk order' })
  lines!: readonly PicklistLineDto[];
}

export class WaveDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ enum: [...WAVE_STATUSES] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  releasedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [PicklistDto] })
  picklists!: readonly PicklistDto[];
}

export class WaveResponse {
  @ApiProperty({ type: WaveDto })
  wave!: WaveDto;
}

/** One header row of the wave list (no picklists — the detail read carries them). */
export class WaveEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ enum: [...WAVE_STATUSES] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  releasedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ description: 'Picklists on this wave' })
  picklistCount!: number;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class WaveListResponse {
  @ApiProperty({ type: [WaveEntryDto] })
  items!: readonly WaveEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── Picking (Story 4.3) ─────────────────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/outbound/picks body — the `pick.record` op, one
 * scan-verified pick of one picklist line. The bin is what the operator
 * SCANNED (the plan's bin is a suggestion re-derived server-side); the batch
 * is never client-supplied — the server re-derives it FEFO inside the bin
 * that was actually scanned.
 */
export class RecordPickDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the pick draws from' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The picklist whose walk is being executed' })
  @IsUUID()
  picklistId!: string;

  @ApiProperty({ format: 'uuid', description: 'The pick line being drawn (one slice of one order line)' })
  @IsUUID()
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the operator scanned — verified against the line' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the operator scanned — checked against live stock, not against the plan' })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    description: 'Units drawn in base UoM — exactly the line’s planned quantity (full-quantity picks only in this release)',
    minimum: 1,
    maximum: 2147483647,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  qty!: number;

  @ApiProperty({ description: 'Device time of the pick (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 200,
    description: 'The serial numbers of a serial-tracked pick (one per drawn unit, no duplicates)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];
}

/** One pick as every surface returns it (the idempotency snapshot). */
export class PickDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the units were actually drawn from' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested bin (advisory)' })
  suggestedBinId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  suggestedBinCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The batch re-derived FEFO in the scanned bin; null when untracked or when the draw spanned several batches' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested batch (advisory)' })
  suggestedBatchId!: string | null;

  @ApiProperty({ description: 'Units drawn (base UoM)' })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The order line’s journal hold' })
  reservationId!: string | null;

  @ApiProperty({ description: 'True when this pick settled the hold (held → committed) in the same transaction as the draw' })
  reservationCommitted!: boolean;

  @ApiProperty({ enum: [...PICKLIST_LINE_STATUSES], description: 'The pick line’s status after the pick' })
  lineStatus!: string;

  @ApiProperty({ format: 'uuid' })
  pickedBy!: string;

  @ApiProperty({ description: 'Device time of the pick (AD-1)' })
  pickedAt!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC server record time' })
  createdAt!: string;
}

export class PickResponse {
  @ApiProperty({ type: PickDto })
  pick!: PickDto;
}

/**
 * One pick task of the sealed device snapshot (AD-4): a released wave's
 * still-unpicked pick line. The bin and batch it names are the plan's
 * SUGGESTION — the server re-derives both at pick time.
 */
export class PickTaskDto {
  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ format: 'uuid', description: 'The suggested bin (the walk stop)' })
  binId!: string;

  @ApiProperty({ description: 'The suggested bin’s code — the walk key' })
  binCode!: string;

  @ApiProperty({ type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'Units to draw at this stop' })
  qty!: number;

  @ApiProperty({ description: 'The order line’s slice index' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Position on the walk (bins.code ascending)' })
  walkSeq!: number;

  @ApiProperty({ description: 'Distinct bin stops left on this picklist’s walk' })
  stopCount!: number;
}
