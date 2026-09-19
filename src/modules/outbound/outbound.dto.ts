import { Transform, Type } from 'class-transformer';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_FIELD_DESCRIPTION,
} from '../../shared/primitives/quantity';
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
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ORDER_SOURCES, ORDER_STATUSES } from './order.command';
import { SHORT_PICK_REASON_CODES } from './pick.command';
// The pack bounds are the COMMAND's constants, imported rather than copied:
// a literal here and a constant there drift silently, and the DTO is the
// gate every HTTP caller actually hits. (`order.command` / `pick.command`
// set the precedent above; `pack.command` imports no DTO, so no cycle.)
import { MAX_DIMENSION_MM, MAX_SCAN_LINES, MAX_WEIGHT_GRAMS } from './pack.command';
import { MAX_HANDLING_UNITS_PER_REQUEST } from '../catalog/handling-unit';
import { MAX_CARRIER_NAME_LENGTH, MAX_TRACKING_NUMBER_LENGTH } from './dispatch.command';
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
    description: `Ordered quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
    example: 10,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
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

  @ApiProperty({
    description:
      "The order's lifecycle arm. 'ready_to_dispatch' (story 4.5) is a packed order: verified at the bench against what was picked and waiting for dispatch. 'dispatched' (story 4.6) is terminal — the order shipped, its shipment is journalled and its reservations are retired; there is no un-dispatch.",
    enum: [...ORDER_STATUSES],
  })
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

  @ApiProperty({ enum: [...ORDER_STATUSES] })
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

  @ApiProperty({
    description:
      'Uncovered units — non-zero on an unfulfillable slice (nothing pickable was ever found) and on a short one (story 4.4: qty − shortfallQty is what actually moved)',
  })
  shortfallQty!: number;

  // `null` rides INSIDE the enum deliberately: OAS 3.0's sibling `nullable`
  // is dropped by the client generator when an `enum` is present, which
  // would hand every consumer a non-null type for a field that is null on
  // every line except a short-picked one.
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES, null],
    description: 'Story 4.4: why a short line came up short; null on every other line',
  })
  reasonCode!: string | null;

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
    // The trailing "below 0.001 is refused" sentence came off in story 10.2 —
    // see `StockAdjustmentDto.quantityDelta` for why.
    description:
      `Units actually drawn in base UoM. Equal to the line’s planned quantity for an ordinary pick; BELOW it (down to 0, an empty bin) for a short pick, which must carry a reasonCode. Above the plan is always a 400. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
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

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    description:
      'Story 4.3b (AD-14): the scanned bin’s state_epoch as the device read it from the sealed snapshot at task start. Opaque and compared only for equality — never interpreted. Omit it (or send null) and the replay behaves exactly as it did before this story: a device whose cache predates the field is never refused for the absence of it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  binStateEpoch?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES],
    description:
      'Story 4.4: why this stop came up short. REQUIRED whenever qty is below the line’s planned quantity (including 0), refused outside the fixed set with a 400 naming the whole set, and ignored when qty equals the plan (that is an ordinary full pick). It is part of the idempotency payload hash — the reason is intent, not an observation.',
  })
  @IsOptional()
  // `@IsIn` over the same tuple the `enum` above documents: a generated client
  // gets a closed type, so the pipe must refuse anything outside it too —
  // otherwise the contract says one thing and the validator accepts another,
  // and the command's own 400 becomes the only real gate.
  @IsIn([...SHORT_PICK_REASON_CODES])
  reasonCode?: string | null;
}

/** One slice a short pick re-planned the remainder onto (story 4.4). */
export class ReplannedSliceDto {
  @ApiProperty({ format: 'uuid', description: 'The NEW pick line carrying the remainder' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid', description: 'The alternate bin — never the bin that came up short' })
  binId!: string;

  @ApiProperty({ description: 'The alternate bin’s code — the walk key' })
  binCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'FEFO batch suggestion; null when untracked' })
  batchId!: string | null;

  @ApiProperty({ description: 'Units to draw at the alternate bin' })
  qty!: number;

  @ApiProperty({ description: 'The order line’s next unused slice index' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Walk position — after every stop the picklist already had' })
  walkSeq!: number;
}

/** One pick as every surface returns it (the idempotency snapshot). */
export class PickDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The picks row id — NULL on a zero-unit short pick (story 4.4), which writes no picks row at all: nothing moved, so there is no ledger event and no settlement record. Every other pick, short or whole, has one.',
  })
  id!: string | null;

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

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested batch code — paired with the id, like the bin arms' })
  suggestedBatchCode!: string | null;

  @ApiProperty({ description: 'Units drawn (base UoM)' })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The order line’s journal hold' })
  reservationId!: string | null;

  @ApiProperty({ description: 'True when this pick settled the hold (held → committed) in the same transaction as the draw' })
  reservationCommitted!: boolean;

  @ApiProperty({
    enum: [...PICKLIST_LINE_STATUSES],
    description:
      'The pick line’s status after the pick — picked on a whole-quantity draw, short (story 4.4, terminal) when the operator drew fewer units than the stop planned',
  })
  lineStatus!: string;

  @ApiProperty({ description: 'Units the stop planned but never moved — 0 on a whole-quantity pick' })
  shortfallQty!: number;

  // The same null-inside-the-enum reason as `PicklistLineDto.reasonCode`.
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES, null],
    description: 'Why the stop came up short (story 4.4); null on a whole-quantity pick',
  })
  reasonCode!: string | null;

  @ApiProperty({
    description:
      'True when this command RELEASED the order line’s hold (story 4.4): a short pick releases the whole hold and re-grants the remainder, because reservations are whole-quantity rows with no partial commit',
  })
  reservationReleased!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The fresh hold covering everything the order line still owes after the release — null when there was no remainder, or when it could not be re-held (the partial-order path). The re-planned slices and every still-open sibling slice carry it.',
  })
  replanReservationId!: string | null;

  @ApiProperty({
    type: [ReplannedSliceDto],
    description: 'The new slices the remainder was re-planned onto — empty on the partial-order path',
  })
  replanned!: readonly ReplannedSliceDto[];

  @ApiProperty({ format: 'uuid' })
  pickedBy!: string;

  @ApiProperty({ description: 'Device time of the pick (AD-1)' })
  pickedAt!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC server record time' })
  createdAt!: string;

  @ApiProperty({
    enum: ['none', 'applied', 'settled'],
    description:
      'Story 4.3b (AD-14): the taxonomy arm this pick settled under — none (no epoch sent, or the bin’s epoch still matched), applied (the epoch had moved and the draw stood on its own), settled (the moved-on bin still covered the draw and this pick settled the order line’s hold). The taxonomy’s two refusal arms write nothing, so they never appear here.',
  })
  conflictClass!: 'none' | 'applied' | 'settled';
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

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Story 4.3b (AD-14): the stop bin’s state_epoch at snapshot time — opaque, compared only for equality. The device carries it back on the queued pick so the server can classify a conflict instead of rejecting blindly. Null when the bin has no epoch row yet (no movement has ever touched it).',
  })
  binStateEpoch!: number | null;
}

// ── Packing (Story 4.5) ─────────────────────────────────────────────────────

/**
 * The parcel's measured box. All three arms are required INSIDE the object —
 * a box with two sides is not a measurement — and the whole object is
 * optional, which is what makes "weight and dimensions are optional" a shape
 * rather than a rule someone has to remember.
 */
export class PackDimensionsDto {
  @ApiProperty({ description: 'Length in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  lengthMm!: number;

  @ApiProperty({ description: 'Width in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  widthMm!: number;

  @ApiProperty({ description: 'Height in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  heightMm!: number;
}

/** One scanned line at the bench: a SKU and the units counted into the parcel. */
export class PackScanLineDto {
  @ApiProperty({ format: 'uuid', description: 'The SKU the operator scanned' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description:
      'Units of this SKU counted into the parcel, in base UoM. Two lines naming the same SKU sum — the bench scans items, not lines.',
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    maxItems: MAX_HANDLING_UNITS_PER_REQUEST,
    description:
      'Catch weight (story 10.3): the handling units of this SKU counted into the parcel — supplied PER SKU, never per order line, because the bench cannot tell which line of a two-line order a case belongs to. The server derives that split from the picks. Required for a catch-weight-tracked SKU (one id per picked unit), refused for every other SKU.',
  })
  @IsOptional()
  @IsArray()
  // The SAME named constant the command tier enforces request-wide.
  @ArrayMaxSize(MAX_HANDLING_UNITS_PER_REQUEST)
  @IsUUID('all', { each: true })
  handlingUnitIds?: string[];
}

/**
 * POST /tenants/{tenantId}/outbound/orders/{orderId}/pack body — the scanned
 * contents of the parcel, verified against what the order actually had
 * PICKED (never against what it ordered: after story 4.4 a short-picked order
 * legitimately reaches the bench with fewer units than its lines asked for).
 */
export class PackOrderDto {
  @ApiProperty({
    type: [PackScanLineDto],
    description:
      'What the operator scanned into the parcel. May be empty only when the order picked nothing at all (every stop reported an empty bin).',
    maxItems: MAX_SCAN_LINES,
  })
  @IsArray()
  @ArrayMaxSize(MAX_SCAN_LINES)
  @ValidateNested({ each: true })
  @Type(() => PackScanLineDto)
  scanned!: PackScanLineDto[];

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: MAX_WEIGHT_GRAMS,
    description: 'Optional parcel weight in grams. Absence is never an error; a non-positive value is a 400.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WEIGHT_GRAMS)
  weightGrams?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: PackDimensionsDto,
    description: 'Optional parcel dimensions in millimetres — all three sides together, or the object omitted.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PackDimensionsDto)
  dimensionsMm?: PackDimensionsDto | null;
}

/** One line of the packing slip. */
export class PackedLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'What the order asked for' })
  orderedQty!: number;

  @ApiProperty({ description: 'What is actually in the parcel — the PICKED units' })
  packedQty!: number;

  @ApiProperty({ description: 'Derived: orderedQty − packedQty (non-zero on a short-picked line)' })
  shortfallQty!: number;

  @ApiProperty({ format: 'uuid', description: 'The pack.packed event this line’s verification was journalled as' })
  ledgerEventId!: string;
}

/**
 * The packing slip as a STRUCTURED PAYLOAD — the repo has no PDF, template or
 * download machinery, so rendering belongs to whichever surface prints it.
 * This is also the idempotency snapshot: a replay re-serves the same slip.
 */
export class PackDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES], description: 'Always ready_to_dispatch on a successful pack' })
  orderStatus!: string;

  @ApiProperty({ enum: [...ORDER_SOURCES] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({ format: 'uuid', description: 'The operator who packed it' })
  packedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC pack time' })
  packedAt!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Parcel weight in grams; null when unmeasured' })
  weightGrams!: number | null;

  @ApiProperty({ type: PackDimensionsDto, nullable: true, description: 'Parcel dimensions in millimetres; null when unmeasured' })
  dimensionsMm!: PackDimensionsDto | null;

  @ApiProperty({ description: 'Total units in the parcel — the sum of every line’s packedQty' })
  totalUnits!: number;

  @ApiProperty({ type: [PackedLineDto] })
  lines!: readonly PackedLineDto[];
}

export class PackResponse {
  @ApiProperty({ type: PackDto })
  pack!: PackDto;
}

/**
 * POST /tenants/{tenantId}/outbound/packs body — the DEVICE pack route
 * (story 10.7). The same scan shape the tenant pack route verifies
 * (`PackOrderDto`, inherited validators and all), with the order id moved
 * into the BODY because a device route names no path order id. The device
 * client never captures parcel dimensions, so `dimensionsMm` is OMITTED —
 * the OpenAPI stops advertising it and (the whitelist pipe runs
 * `forbidNonWhitelisted`) a device body that sends it is REFUSED with a 400;
 * the web surface keeps the arm (review W6, story 10.7).
 */
export class DevicePackDto extends OmitType(PackOrderDto, ['dimensionsMm'] as const) {
  @ApiProperty({ format: 'uuid', description: 'The fully-picked order being packed' })
  @IsUUID()
  orderId!: string;
}

// ── Dispatch (Story 4.6) ────────────────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/outbound/orders/{orderId}/dispatch body — the
 * order's terminal transition. Both fields are OPTIONAL free text (the human
 * decision, 2026-09-15): an operator shipping by a manual courier records
 * what they have today, and the carrier-adapter stories later replace them
 * with a real carrier id and an adapter-issued tracking number. An empty
 * body is a complete, valid dispatch.
 */
export class DispatchOrderDto {
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: MAX_CARRIER_NAME_LENGTH,
    description:
      'Optional free-text carrier (e.g. a manual courier). Absence is never an error; a blank string is treated as absent.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @Length(0, MAX_CARRIER_NAME_LENGTH)
  carrierName?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: MAX_TRACKING_NUMBER_LENGTH,
    description:
      'Optional free-text tracking or consignment reference. Absence is never an error; a blank string is treated as absent.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @Length(0, MAX_TRACKING_NUMBER_LENGTH)
  trackingNumber?: string | null;
}

/** One line of the dispatch record. */
export class DispatchedLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'What the order asked for' })
  orderedQty!: number;

  @ApiProperty({ description: 'What actually shipped for this line — the PICKED units' })
  dispatchedQty!: number;

  @ApiProperty({ description: 'Derived: orderedQty − dispatchedQty (non-zero on a short-picked line)' })
  shortfallQty!: number;

  @ApiProperty({ format: 'uuid', description: 'The dispatch.dispatched event this line’s shipment was journalled as' })
  ledgerEventId!: string;
}

/**
 * The dispatch record — also the idempotency snapshot, so a replay re-serves
 * it unchanged. `dispatched` is terminal: there is no un-dispatch, no return
 * and no re-open.
 */
export class DispatchDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES], description: 'Always dispatched on a successful dispatch' })
  orderStatus!: string;

  @ApiProperty({ enum: [...ORDER_SOURCES] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({ format: 'uuid', description: 'The operator who dispatched it' })
  dispatchedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC dispatch time' })
  dispatchedAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Free-text carrier; null when none was recorded' })
  carrierName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Free-text tracking reference; null when none was recorded' })
  trackingNumber!: string | null;

  @ApiProperty({ description: 'Total units shipped — the sum of every line’s dispatchedQty' })
  totalUnits!: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The reservation holds this dispatch retired committed → released — the ATP correction. Empty when the order had none left to retire.',
  })
  retiredReservationIds!: readonly string[];

  @ApiProperty({ type: [DispatchedLineDto] })
  lines!: readonly DispatchedLineDto[];
}

export class DispatchResponse {
  @ApiProperty({ type: DispatchDto })
  dispatch!: DispatchDto;
}
