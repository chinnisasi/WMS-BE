import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { QC_HOLD_KINDS, type QcHoldKind } from './qc.command';

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

  @ApiProperty({ enum: ['open', 'released'] })
  status!: 'open' | 'released';

  @ApiProperty({ format: 'uuid' })
  heldBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  heldAt!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  releasedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC instant when released; null while the hold is open' })
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
}

export class QcHoldListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Filter by warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: ['open', 'released'] })
  @IsOptional()
  @IsIn(['open', 'released'])
  status?: 'open' | 'released';

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
