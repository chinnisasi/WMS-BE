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

/**
 * The typed `reference_doc` union arm as it exists today (AD-11) — the
 * timeline's passthrough. Story 3.3 adds the additive `grn-receipt` arm
 * ({kind, grnId, poId?, poLineId?}); future event kinds extend the union
 * additively — this DTO documents the shape clients see.
 */
export class LedgerReferenceDocDto {
  @ApiProperty({ example: 'manual-adjustment', description: 'Discriminator of the typed reference union' })
  kind!: string;

  @ApiProperty({
    required: false,
    description: 'Machine reason for the correction (e.g. stock-count) — manual-adjustment arm only',
  })
  reasonCode?: string;

  @ApiProperty({
    required: false,
    description: "The Ops Manager's note, carried verbatim — manual-adjustment arm only",
  })
  note?: string;

  @ApiProperty({
    required: false,
    description: 'The recorded reason when a draw overrode the FEFO default batch (absent on every other adjustment)',
  })
  overrideReason?: string;

  // ── the grn-receipt arm (Story 3.3, additive) ─────────────────────────────

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'The GRN the movement landed under (grn-receipt arm only)',
  })
  grnId?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'The PO received against (grn-receipt arm only — absent on a blind receipt)',
  })
  poId?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'The exact PO line (grn-receipt arm only — absent on the blind arm)',
  })
  poLineId?: string;
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

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Story 2.4 batch arm — the catalog batch id; null on every arm-less (legacy) event',
  })
  batchRef!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Story 2.4 serial arm — the catalog serial id; null on every arm-less (legacy) event',
  })
  serialRef!: string | null;

  @ApiProperty({
    type: LedgerReferenceDocDto,
    nullable: true,
    description:
      'The typed reference document itself ({kind, reasonCode, note, overrideReason?} today) — the event\'s reference document, extended additively by future event kinds',
  })
  referenceDoc!: LedgerReferenceDocDto | null;

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

// ── Story 2.5: the inventory read surfaces (stock, batches, serials) ──────

/** Query of the stock-list read (keyset cursor pagination). */
export class StockListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Only rows of one SKU' })
  @IsOptional()
  @IsUUID()
  skuId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Only rows of one bin' })
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

/** One on-hand projection row of the stock list (no batch fields — plain stock truth). */
export class StockEntryDto {
  @ApiProperty({ format: 'uuid', description: 'The projection row id (the cursor tiebreaker)' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ description: 'On-hand in base UoM (non-negative)', minimum: 0 })
  quantity!: number;

  @ApiProperty({ description: 'ISO-8601 UTC projection-row commit time (the cursor sort key)' })
  createdAt!: string;
}

/** GET …/warehouses/{warehouseId}/inventory/stock response. */
export class StockListResponse {
  @ApiProperty({ type: [StockEntryDto] })
  items!: readonly StockEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

/** Query of the batch list (the FEFO-ordered catalog × on-hand join). */
export class BatchListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'The SKU whose batches are listed (required — 400 when omitted)' })
  @IsOptional()
  @IsUUID()
  skuId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Only on-hand rows of one bin (the quantity narrows with it)' })
  @IsOptional()
  @IsUUID()
  binId?: string;
}

/** One batch-list row: catalog identity joined with its on-hand quantity. */
export class BatchListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Batch code (unique per tenant + SKU)' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Manufacturing date (ISO-8601 UTC), null when unrecorded' })
  mfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Expiry date (ISO-8601 UTC), null when unrecorded — orders last (FEFO)' })
  expiryDate!: string | null;

  @ApiProperty({ description: 'Batch lifecycle status (active today)' })
  status!: string;

  @ApiProperty({ description: 'On-hand of this batch in the queried warehouse (the bin filter applied; 0 when none)' })
  quantity!: number;
}

/** GET …/warehouses/{warehouseId}/inventory/batches response (FEFO order). */
export class BatchListResponse {
  @ApiProperty({ type: [BatchListItemDto] })
  items!: readonly BatchListItemDto[];
}

/** One per-bin on-hand row of a batch (the detail's "where the stock lives"). */
export class BatchBinOnHandDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ description: 'On-hand of the batch in this bin' })
  quantity!: number;
}

/** One ledger event of a batch's movement history (oldest first). */
export class BatchLedgerEntryDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Gap-free per-warehouse replay order' })
  seq!: number;

  @ApiProperty({ example: 'stock.adjusted' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Signed base-UoM delta' })
  quantityDelta!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  fromBinId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toBinId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The serial arm on a combined batch+serial event' })
  serialRef!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC business time' })
  occurredAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC commit time' })
  recordedAt!: string;

  @ApiProperty({ description: 'sha256 over the canonical event bytes (chain link)' })
  eventHash!: string;
}

/** GET …/inventory/batches/{batchId} response — identity, per-bin on-hand, full history. */
export class BatchDetailResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the batch belongs to' })
  skuId!: string;

  @ApiProperty({ description: 'Batch code (unique per tenant + SKU)' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Manufacturing date (ISO-8601 UTC), null when unrecorded' })
  mfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Expiry date (ISO-8601 UTC), null when unrecorded' })
  expiryDate!: string | null;

  @ApiProperty({ description: 'Batch lifecycle status (active today)' })
  status!: string;

  @ApiProperty({ type: [BatchBinOnHandDto], description: 'Per-bin on-hand rows across every warehouse of the tenant' })
  bins!: readonly BatchBinOnHandDto[];

  @ApiProperty({ type: [BatchLedgerEntryDto], description: 'Full movement history (oldest first, one query)' })
  history!: readonly BatchLedgerEntryDto[];
}

/** The serial's derived current location (the ledger's latest event's bin). */
export class SerialLocationDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;
}

/** One ledger event of a serial's movement history (oldest first). */
export class SerialLedgerEntryDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Gap-free per-warehouse replay order' })
  seq!: number;

  @ApiProperty({ example: 'stock.adjusted' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Signed base-UoM delta (±1 per serial unit)' })
  quantityDelta!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  fromBinId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  toBinId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The batch the unit moved with (null when unbatched)' })
  batchRef!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC business time' })
  occurredAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC commit time' })
  recordedAt!: string;

  @ApiProperty({ description: 'sha256 over the canonical event bytes (chain link)' })
  eventHash!: string;
}

/** GET …/inventory/serials/{serialId} response — identity, derived location, full history. */
export class SerialDetailResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the serial belongs to' })
  skuId!: string;

  @ApiProperty({ description: 'The serial number (unique per tenant + SKU)' })
  serialNumber!: string;

  @ApiProperty({ description: 'Serial lifecycle status (active today)' })
  status!: string;

  @ApiProperty({
    type: SerialLocationDto,
    nullable: true,
    description: 'Derived current location — the ledger’s latest event’s bin (tenant-wide); null when never moved',
  })
  location!: SerialLocationDto | null;

  @ApiProperty({ type: [SerialLedgerEntryDto], description: 'Full movement history (oldest first, one query)' })
  history!: readonly SerialLedgerEntryDto[];
}