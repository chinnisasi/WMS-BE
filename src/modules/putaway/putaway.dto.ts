import { Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { STORAGE_CLASSES } from '../../shared/primitives/storage-class';
import { BIN_BLOCK_REASONS } from '../../shared/db/schema';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PUTAWAY_MISMATCH_REASON_CODES as PUTAWAY_MISMATCH_REASON_ENUM } from './mismatch-reason';

// ── putaway.place input ──────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/putaway/placements body (device session, `putaway.execute`). */
export class PlacePutawayDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the placement lands in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The GRN whose received stock is being put away' })
  @IsUUID()
  grnId!: string;

  @ApiProperty({ format: 'uuid', description: 'The GRN line this placement moves' })
  @IsUUID()
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

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

  @ApiProperty({
    description: `Placed quantity — partial placements allowed. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ format: 'uuid', description: 'The target bin the operator scanned/entered' })
  @IsUUID()
  toBinId!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: PUTAWAY_MISMATCH_REASON_ENUM,
    description: 'The mismatch reason (required when the target bin differs from the suggested bin)',
  })
  @IsOptional()
  @IsIn(PUTAWAY_MISMATCH_REASON_ENUM as unknown as string[])
  reasonCode?: string | null;

  @ApiProperty({ description: 'Device time of the placement (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 200,
    description: 'The serial numbers of a serial-tracked placement (one per unit, no duplicates)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    maxLength: 32,
    description:
      "Story 2-10b — the LPN (licence plate) the operator scanned for this placement: it must be an ACTIVE LPN of this GRN line holding at least `qty`, and the placement consumes it (`placed`). Absent, null or blank = no LPN (the payload hashes exactly as before)",
  })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  lpnCode?: string | null;
}

// ── putaway placement responses ──────────────────────────────────────────────

/** One placement as every surface returns it. */
export class PutawayPlacementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code (server-assigned)' })
  grnCode!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'The SKU code (joined for the report surface)' })
  skuCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The catalog batch code; null on non-batch-tracked SKUs' })
  batchCode!: string | null;

  // The schema floor matches the placement validator (@Min(0.001)) — the
  // response DTO's `minimum` documents the fractional truth, it does not gate.
  @ApiProperty({ description: `The placed quantity. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  qty!: number;

  @ApiProperty({ format: 'uuid', description: 'The system Receiving bin the units left' })
  fromBinId!: string;

  @ApiProperty({ format: 'uuid', description: 'The target bin the operator placed into' })
  toBinId!: string;

  @ApiProperty({ description: 'The target bin code' })
  toBinCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'The server\'s re-derived suggestion; null when no bin fit' })
  suggestedBinId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The suggested bin\'s code; null when no bin fit' })
  suggestedBinCode!: string | null;

  @ApiProperty({ enum: PUTAWAY_MISMATCH_REASON_ENUM, type: String, nullable: true, description: 'The recorded mismatch reason; null when the suggestion was followed' })
  reasonCode!: string | null;

  @ApiProperty({ format: 'uuid' })
  placedBy!: string;

  @ApiProperty({ description: 'Device time of the placement (AD-1), ISO-8601 UTC' })
  placedAt!: string;

  @ApiProperty({ format: 'uuid', description: 'The floor device that recorded the placement' })
  deviceId!: string;

  @ApiProperty({ description: 'Row creation time, ISO-8601 UTC' })
  createdAt!: string;
}

export class PutawayPlacementResponse {
  @ApiProperty({ type: PutawayPlacementDto })
  placement!: PutawayPlacementDto;
}

export class PutawayPlacementListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only placements of one client's SKUs. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

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

export class PutawayPlacementListResponse {
  @ApiProperty({ type: [PutawayPlacementDto] })
  items!: readonly PutawayPlacementDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── derived tasks + snapshot bins ────────────────────────────────────────────

/** The suggestion's bin reference (the snapshot shape). */
export class SuggestedBinDto {
  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;
}

/** Story 2-10b — one active LPN (licence plate) riding its putaway task. */
export class PutawayTaskLpnDto {
  @ApiProperty({ description: 'The LPN code — what the pallet or carton label\'s barcode encodes, byte for byte' })
  code!: string;

  @ApiProperty({ description: 'The declared quantity on the label, base units' })
  qty!: number;
}

/** One derived putaway task of the tasks read / device snapshot. */
export class PutawayTaskDto {
  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code (server-assigned)' })
  grnCode!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'min(applied, receiving-bin on-hand) — the placeable units', minimum: 1 })
  qty!: number;

  @ApiProperty({ type: SuggestedBinDto, nullable: true, description: 'The suggested bin; null when no storage bin has room' })
  suggestedBin!: SuggestedBinDto | null;

  @ApiProperty({ description: 'The one-line capacity-only rationale' })
  rationale!: string;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      "Story 2-6a — present only on a SERIAL-TRACKED task: the GRN line's booked serial numbers still in the Receiving bin, in capture order (qty is their count). The handheld verifies each scan against this list offline; a serial task without it (an older server, a legacy anonymous line) cannot be placed from the handheld",
  })
  serialNumbers?: readonly string[];

  @ApiProperty({
    type: [PutawayTaskLpnDto],
    description:
      "Story 2-10b — the GRN line's ACTIVE LPNs (licence plates) in code order; empty when none. A handheld scan of one chooses this task, verified, with the quantity prefilled (min of the LPN's and the task's). Placed and voided LPNs never appear",
  })
  lpns!: readonly PutawayTaskLpnDto[];
}

export class PutawayTaskListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only tasks of one client's SKUs. An unknown id is an empty list" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ format: 'uuid', description: 'Warehouse the tasks are derived for' })
  @IsUUID()
  warehouseId!: string;
}

export class PutawayTaskListResponse {
  @ApiProperty({ type: [PutawayTaskDto] })
  items!: readonly PutawayTaskDto[];
}

/** One bin of the device snapshot's bins payload (blocked/system bins included). */
export class PutawayBinDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty()
  zoneCode!: string;

  @ApiProperty({ description: 'The fixed location type (12-4 vocabulary): shelf, pallet, floor, staging, floor-stack, yard, tank or silo' })
  type!: string;

  @ApiProperty({ description: 'Capacity in base-UoM units' })
  capacity!: number;

  @ApiProperty({ description: 'Broken-bin flag — blocked bins reject placements' })
  blocked!: boolean;

  @ApiProperty({
    enum: [...BIN_BLOCK_REASONS, null],
    nullable: true,
    description: 'Story 3-3b — why the bin is blocked (null while active); the handheld names it on its refusals. A client reading a snapshot cached before 3-3b treats an absent field as null',
  })
  blockedReason!: string | null;

  @ApiProperty({ description: 'System bins (Receiving/QC-hold) are never placement targets' })
  systemOwned!: boolean;

  @ApiProperty({
    description:
      'Story 3-5b — the bin is frozen for a stock take: the handheld refuses every movement into or out of it offline (count it, or wait for the take to close). A client reading a snapshot cached before 3-5b treats an absent field as false',
  })
  frozen!: boolean;

  @ApiProperty({
    enum: [...STORAGE_CLASSES],
    description:
      'Story 12.8 (UX-DR29): the bin\'s storage class (defaults to `ambient`). It rides the snapshot beside the SKU arm\'s class (the catalog snapshot) so the device\'s offline conformance mirror can refuse a non-conforming placement in the Rejected banner — before anything queues.',
  })
  storageClass!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Story 1-5b: the client this bin is dedicated to (null = shared). A dedicated bin refuses any other client\'s stock; the device mirrors the rule offline (the snapshot `clients` arm names the client), the server re-gates at placement and transfer receive.',
  })
  dedicatedClientId!: string | null;
}