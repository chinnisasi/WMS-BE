import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { MAX_QUANTITY_MILLI } from '../../shared/primitives/quantity';
import {
  REPLENISHMENT_BREACH_STATUSES,
  SUGGESTED_PO_STATUSES,
} from '../../shared/db/schema';
import type { PurchaseOrderLineDto } from '../inbound/inbound.dto';
import { PurchaseOrderDto } from '../inbound/inbound.dto';

/** The milli-unit wire bound — the stored `bigint` column's exact range (the variance-threshold ceiling's derivation). */
const MAX_REPLENISHMENT_MILLI = MAX_QUANTITY_MILLI;

// ── reorder policy: upsert + list ───────────────────────────────────────────

/** One per-warehouse reorder override as the client supplies it (milli-units, strictly positive). */
export class UpsertReorderPolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description:
      'Reorder point in MILLI-units (base UoM × 10³) — the ATP level below which a breach opens. ' +
      'Strictly positive; the per-warehouse override replaces the SKU-column default.',
    minimum: 1,
    maximum: MAX_REPLENISHMENT_MILLI,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPLENISHMENT_MILLI)
  reorderPoint!: number;

  @ApiProperty({
    description:
      'Reorder quantity in MILLI-units (base UoM × 10³) — the draft PO\'s default suggested quantity. Strictly positive.',
    minimum: 1,
    maximum: MAX_REPLENISHMENT_MILLI,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPLENISHMENT_MILLI)
  reorderQty!: number;
}

export class ReorderPolicyListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Only one warehouse\'s policies' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Only one SKU\'s policies' })
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

export class ReorderPolicyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Reorder point in milli-units (base UoM × 10³)' })
  reorderPoint!: number;

  @ApiProperty({ description: 'Reorder quantity in milli-units (base UoM × 10³)' })
  reorderQty!: number;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last-write time' })
  updatedAt!: string;
}

export class ReorderPolicyResponse {
  @ApiProperty({ type: ReorderPolicyDto })
  policy!: ReorderPolicyDto;
}

export class ReorderPolicyListResponse {
  @ApiProperty({ type: [ReorderPolicyDto] })
  items!: readonly ReorderPolicyDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── breach: list + dismiss ──────────────────────────────────────────────────

export class BreachListQuery {
  @ApiProperty({
    required: false,
    enum: [...REPLENISHMENT_BREACH_STATUSES],
    description: 'Only breaches of one status (the queue tabs)',
  })
  @IsOptional()
  @IsIn([...REPLENISHMENT_BREACH_STATUSES])
  status?: (typeof REPLENISHMENT_BREACH_STATUSES)[number];

  @ApiProperty({ required: false, format: 'uuid', description: 'Only one warehouse\'s breaches' })
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

export class BreachDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ enum: [...REPLENISHMENT_BREACH_STATUSES] })
  status!: (typeof REPLENISHMENT_BREACH_STATUSES)[number];

  @ApiProperty({ description: 'The reorder point FROZEN at detection, milli-units' })
  pointMilli!: number;

  @ApiProperty({ description: 'The ATP FROZEN at detection, milli-units' })
  atpMilli!: number;

  @ApiProperty({ description: 'The breach instant (ISO-8601 UTC) — the row\'s creation time' })
  breachAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Resolution instant, null while open' })
  resolvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The resolver\'s user id, null while open (and on worker recovery)' })
  resolvedBy!: string | null;
}

export class BreachResponse {
  @ApiProperty({ type: BreachDto })
  breach!: BreachDto;
}

export class BreachListResponse {
  @ApiProperty({ type: [BreachDto] })
  items!: readonly BreachDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── suggested PO: list + submit ─────────────────────────────────────────────

export class SuggestedPoListQuery {
  @ApiProperty({
    required: false,
    enum: [...SUGGESTED_PO_STATUSES],
    description: 'Only suggested POs of one status (the queue tabs)',
  })
  @IsOptional()
  @IsIn([...SUGGESTED_PO_STATUSES])
  status?: (typeof SUGGESTED_PO_STATUSES)[number];

  @ApiProperty({ required: false, format: 'uuid', description: 'Only one warehouse\'s drafts' })
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

export class SuggestedPoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The breach whose opening minted the draft' })
  breachId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The suggested vendor, null when the tenant carried no default' })
  vendorId!: string | null;

  @ApiProperty({ description: 'The suggested quantity in milli-units (base UoM × 10³)' })
  quantityMilli!: number;

  @ApiProperty({ enum: [...SUGGESTED_PO_STATUSES] })
  status!: (typeof SUGGESTED_PO_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true, description: 'The real PO\'s id once submitted, null while a draft' })
  submittedPoId!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last-write time' })
  updatedAt!: string;
}

export class SuggestedPoResponse {
  @ApiProperty({ type: SuggestedPoDto })
  suggestedPo!: SuggestedPoDto;
}

export class SuggestedPoListResponse {
  @ApiProperty({ type: [SuggestedPoDto] })
  items!: readonly SuggestedPoDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

/**
 * The submit's optional edits: both omitted keep the draft's own values.
 * The BODY ITSELF is optional on the route (a bare submit keeps the draft).
 */
export class SubmitSuggestedPoDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The vendor to purchase from — omitted keeps the draft\'s (a null-vendor draft refuses without it)' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    description:
      'The quantity to order in MILLI-units (strictly positive; positive-integer-milli bound). ' +
      'Omitted keeps the draft\'s quantity.',
    minimum: 1,
    maximum: MAX_REPLENISHMENT_MILLI,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPLENISHMENT_MILLI)
  quantityMilli?: number;
}

/**
 * The submit response (the amendment): the draft's id plus the FLAT PO
 * snapshot — `purchaseOrder` IS the PO, never the inbound facade's wrapped
 * `{purchaseOrder: {…}}` carrier (that wrap made the surface read
 * `undefined` where the minted code goes). Typed, not `Object` — the shape
 * is the contract.
 */
export class SubmitSuggestedPoResponse {
  @ApiProperty({ format: 'uuid' })
  suggestedPoId!: string;

  @ApiProperty({ type: PurchaseOrderDto })
  purchaseOrder!: PurchaseOrderDto;
}

export type { PurchaseOrderDto, PurchaseOrderLineDto };