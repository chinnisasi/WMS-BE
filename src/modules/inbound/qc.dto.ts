import { Type } from 'class-transformer';
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
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE, MIN_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import {
  MAX_INSPECTION_NOTE_LENGTH,
  QC_FAIL_REASONS,
  QC_HOLD_KINDS,
  QC_HOLD_STATUSES,
  QC_INSPECTION_OUTCOMES,
  type QcFailReason,
  type QcHoldKind,
  type QcHoldStatus,
  type QcInspectionOutcome,
} from './qc.command';

/** Story 2-8a — the list's status filter: one status, or `closed` (released or inspected — the web's Closed tab). */
export const QC_HOLD_STATUS_FILTERS = [...QC_HOLD_STATUSES, 'closed'] as const;
export type QcHoldStatusFilter = (typeof QC_HOLD_STATUS_FILTERS)[number];

// ── qc-holds.place input ─────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/receiving/qc-holds body (tenant session, `qc.manage`). */
export class PlaceQcHoldDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse holding the stock' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The scope\'s origin bin — captured at hold time; release returns the stock here',
  })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    description:
      'Why the stock is quarantined (free-form, carried verbatim; at most 200 characters)',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  reason!: string;
}

// ── qc-hold responses ────────────────────────────────────────────────────────

/** One QC hold as every surface returns it. */
export class QcHoldDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid', description: 'The origin bin (release returns here)' })
  binId!: string;

  @ApiProperty({ description: 'Why the stock is quarantined (carried verbatim)' })
  reason!: string;

  @ApiProperty({
    enum: [...QC_HOLD_STATUSES],
    description: 'Story 2-8a — `inspected`: closed by an inspection outcome (released/inspected both carry releasedBy/releasedAt, read as closed by/at)',
  })
  status!: QcHoldStatus;

  @ApiProperty({ format: 'uuid' })
  heldBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  heldAt!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'Who closed the hold (released or inspected it); null while open' })
  releasedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC instant the hold closed (released or inspected); null while the hold is open' })
  releasedAt!: string | null;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({
    enum: [...QC_HOLD_KINDS],
    required: false,
    description:
      "Story 1-2b — `receipt`: placed by the receipt itself (the client's QC on receipt), one per GRN line; `manual`: an Ops Manager's (sku, bin) scope hold. Always present on the list; on a command's answer present only for a receipt hold",
  })
  kind?: QcHoldKind;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 1-2b — the GRN line a receipt hold holds (receipt holds only)' })
  grnLineId?: string;
}

/** Story 1-2b — one row of the holds list: the hold plus what a reviewer needs to work it. */
export class QcHoldEntryDto extends QcHoldDto {
  @ApiProperty({ enum: [...QC_HOLD_KINDS], required: true, description: "Story 1-2b — `receipt`: placed by the receipt itself (the client's QC on receipt), one per GRN line; `manual`: an Ops Manager's (sku, bin) scope hold" })
  declare kind: QcHoldKind;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: "Story 1-2b — the receipt hold's GRN (null on a manual hold)" })
  grnId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Story 1-2b — the receipt hold's GRN code (null on a manual hold)" })
  grnCode!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'Story 1-2b — set when the receipt hold holds an approved over-receipt\'s excess' })
  overReceiptId!: string | null;

  @ApiProperty({ format: 'uuid', description: "Story 1-2b — the held SKU's client" })
  clientId!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'Story 1-2b — the batch held (null on an untracked SKU, or when a manual hold moved several batches)' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Story 1-2b — that batch\'s code' })
  batchCode!: string | null;

  @ApiProperty({ minimum: 0, description: "Story 1-2b — the quantity the hold moved into QC (the sum of its own qc.held events), base UoM" })
  heldQty!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: 'Story 2-8a — on an inspected hold, the units that failed (moved to DAMAGED), base UoM; null on an open or released hold',
  })
  failedQuantity!: number | null;
}

export class QcHoldListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only holds on one client's SKUs (manual holds included). An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Filter by warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({
    required: false,
    enum: [...QC_HOLD_STATUS_FILTERS],
    description: 'Story 2-8a — `inspected` added; `closed` = released or inspected',
  })
  @IsOptional()
  @IsIn([...QC_HOLD_STATUS_FILTERS])
  status?: QcHoldStatusFilter;

  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-2b — only one goods receipt's QC-on-receipt holds" })
  @IsOptional()
  @IsUUID()
  grnId?: string;

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

export class QcHoldListResponse {
  @ApiProperty({ type: [QcHoldEntryDto] })
  items!: readonly QcHoldEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class QcHoldResponse {
  @ApiProperty({ type: QcHoldDto })
  qcHold!: QcHoldDto;
}
/** Story 1-2b — `POST …/receiving/qc-holds/release-receipt` body. */
export class ReleaseReceiptHoldsDto {
  @ApiProperty({ format: 'uuid', description: 'The goods receipt whose open QC-on-receipt holds are released' })
  @IsUUID()
  grnId!: string;
}

/** Story 1-2b — the release-receipt answer. */
export class ReleaseReceiptHoldsResponse {
  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code' })
  grnCode!: string;

  @ApiProperty({ type: [QcHoldDto], description: 'Every hold this call released' })
  qcHolds!: readonly QcHoldDto[];
}

// ── story 2-8a: the inspection outcome ─────────────────────────────────────

/** One failure of a held arm: a reason and its units. */
export class QcInspectFailureDto {
  @ApiProperty({ enum: [...QC_FAIL_REASONS], description: 'Why these units failed (`other` needs the note)' })
  @IsIn([...QC_FAIL_REASONS])
  reason!: QcFailReason;

  @ApiProperty({ description: `Units failed for this reason (> 0). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: MIN_QUANTITY_BASE, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(MIN_QUANTITY_BASE)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;
}

/** One held batch arm's outcome. passed + Σ failed must equal the arm exactly. */
export class QcInspectLineDto {
  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: "The held arm's batch (null on an untracked SKU's single arm)" })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  batchId!: string | null;

  @ApiProperty({ description: `Units that passed — back to the origin bin (Receiving for a receipt hold). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  passed!: number;

  @ApiProperty({ type: [QcInspectFailureDto], description: 'Units that failed, one entry per reason (none when everything passed) — they move to the DAMAGED bin' })
  @IsArray()
  @ArrayMaxSize(QC_FAIL_REASONS.length)
  @ValidateNested({ each: true })
  @Type(() => QcInspectFailureDto)
  failed!: QcInspectFailureDto[];
}

/** `POST /tenants/{tenantId}/receiving/qc-holds/{holdId}/inspect` body (`qc.manage`). */
export class InspectQcHoldDto {
  @ApiProperty({ type: [QcInspectLineDto], description: 'One line per batch arm the hold moved — exactly those arms, each summing to its held quantity (held quantities are never sent)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => QcInspectLineDto)
  lines!: QcInspectLineDto[];

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    maxLength: MAX_INSPECTION_NOTE_LENGTH,
    description: `The inspector's note (at most ${MAX_INSPECTION_NOTE_LENGTH} characters after trimming; blank = none). Required when a failure's reason is \`other\``,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4 * MAX_INSPECTION_NOTE_LENGTH)
  note?: string | null;
}

/** One stored inspection row. */
export class QcInspectionLineDto {
  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ enum: [...QC_INSPECTION_OUTCOMES] })
  outcome!: QcInspectionOutcome;

  @ApiProperty({ type: String, nullable: true, enum: [...QC_FAIL_REASONS, null], description: 'Present exactly on a failed row' })
  failReason!: QcFailReason | null;

  @ApiProperty({ minimum: 0, description: 'Units, base UoM' })
  quantity!: number;
}

/** The inspection that closed a hold. */
export class QcInspectionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  holdId!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ format: 'uuid', description: "Who inspected (the hold's releasedBy)" })
  inspectedBy!: string;

  @ApiProperty({ description: "When, ISO-8601 UTC (the hold's releasedAt)" })
  inspectedAt!: string;

  @ApiProperty({ minimum: 0, description: 'Σ passed, base UoM' })
  passedQuantity!: number;

  @ApiProperty({ minimum: 0, description: 'Σ failed (moved to DAMAGED), base UoM' })
  failedQuantity!: number;

  @ApiProperty({ type: [QcInspectionLineDto], description: 'By batch (untracked first), passed before failed, failures by reason' })
  lines!: readonly QcInspectionLineDto[];
}

/** The inspect answer (the idempotency snapshot). */
export class InspectQcHoldResponse {
  @ApiProperty({ type: QcHoldDto })
  qcHold!: QcHoldDto;

  @ApiProperty({ type: QcInspectionDto })
  inspection!: QcInspectionDto;
}

/** One batch arm the hold moved into QC. */
export class QcHeldArmDto {
  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'null on an untracked SKU' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The batch's expiry as an IST calendar date (YYYY-MM-DD); null when none" })
  expiryDate!: string | null;

  @ApiProperty({ minimum: 0, description: 'Units held on this arm, base UoM' })
  quantity!: number;
}

/** `GET …/receiving/qc-holds/{holdId}` — one hold, its held arms and, once inspected, the inspection. */
export class QcHoldDetailResponse {
  @ApiProperty({ type: QcHoldEntryDto })
  qcHold!: QcHoldEntryDto;

  @ApiProperty({ type: [QcHeldArmDto], description: 'The batch arms the hold moved (its own qc.held events), untracked first' })
  arms!: readonly QcHeldArmDto[];

  @ApiProperty({ type: QcInspectionDto, nullable: true, description: 'Present once the hold is inspected; null otherwise' })
  inspection!: QcInspectionDto | null;
}
