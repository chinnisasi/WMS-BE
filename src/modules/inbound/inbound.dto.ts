import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
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

// ── Vendor surfaces (Story 3.1) ─────────────────────────────────────────────

/** POST /tenants/{tenantId}/vendors body. */
export class CreateVendorDto {
  @ApiProperty({ description: 'Vendor code — unique per tenant', minLength: 1, maxLength: 64 })
  @Trim()
  @IsString()
  @Length(1, 64)
  code!: string;

  @ApiProperty({ description: 'Vendor name', minLength: 1, maxLength: 200 })
  @Trim()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    required: false,
    default: false,
    description: 'The tenant’s default vendor (Epic 6 suggested-PO drafts read it)',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** Query of the vendor list (keyset cursor pagination). */
export class VendorListQuery {
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

/** One vendor row of the list / create responses. */
export class VendorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ description: 'Vendor code (unique per tenant)' })
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'The tenant’s default vendor flag' })
  isDefault!: boolean;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;
}

export class VendorResponse {
  @ApiProperty({ type: VendorDto })
  vendor!: VendorDto;
}

export class VendorListResponse {
  @ApiProperty({ type: [VendorDto] })
  items!: readonly VendorDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── Purchase-order inputs ───────────────────────────────────────────────────

/** One PO line as the client supplies it (create and amend). */
export class PurchaseOrderLineInputDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Existing line to update (amend only) — omitted means a new line',
  })
  @IsOptional()
  @IsString()
  @IsUUID()
  id?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ description: 'Ordered quantity in base UoM (positive integer)', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderedQty!: number;

  @ApiProperty({
    description: 'Unit cost as integer paise (AD-9 — never a float)',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  unitCostPaise!: number;

  @ApiProperty({
    required: false,
    description: 'Expected receipt date (ISO-8601 UTC, Z-suffixed); optional',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  expectedDate?: string;
}

/** POST /tenants/{tenantId}/inbound/purchase-orders body. */
export class CreatePurchaseOrderDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the PO is scoped to (receiving is per-warehouse)' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vendorId!: string;

  @ApiProperty({ description: 'PO code — client-supplied, unique per tenant', minLength: 1, maxLength: 64 })
  @Trim()
  @IsString()
  @Length(1, 64)
  code!: string;

  @ApiProperty({
    type: [PurchaseOrderLineInputDto],
    minItems: 1,
    maxItems: 200,
    description: 'At least one line with a known SKU',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineInputDto)
  lines!: PurchaseOrderLineInputDto[];
}

/**
 * PATCH /tenants/{tenantId}/inbound/purchase-orders/{poId} body — the full
 * line set: lines with an `id` update in place, lines without one are added,
 * existing lines absent from the request are removed.
 */
export class AmendPurchaseOrderDto {
  @ApiProperty({
    type: [PurchaseOrderLineInputDto],
    minItems: 1,
    maxItems: 200,
    description: 'The complete new line set (update by id, add without id, remove by absence) — at least one line',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineInputDto)
  lines!: PurchaseOrderLineInputDto[];
}

/** One per-line close disposition. */
export class CloseDispositionInputDto {
  @ApiProperty({ format: 'uuid', description: 'The PO line being dispositioned' })
  @IsUUID()
  lineId!: string;

  @ApiProperty({
    enum: ['cancelled', 'carried'],
    description: 'cancelled: the line dies; carried: its open quantity moves to the successor PO',
  })
  @IsIn(['cancelled', 'carried'])
  disposition!: 'cancelled' | 'carried';
}

/** POST /tenants/{tenantId}/inbound/purchase-orders/{poId}/close body. */
export class ClosePurchaseOrderDto {
  @ApiProperty({
    type: [CloseDispositionInputDto],
    minItems: 1,
    maxItems: 200,
    description: 'One disposition per PO line (close is total — every line must be dispositioned)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CloseDispositionInputDto)
  lines!: CloseDispositionInputDto[];
}

// ── Purchase-order read surfaces ────────────────────────────────────────────

/** Query of the PO list (keyset cursor pagination, optional status filter). */
export class PurchaseOrderListQuery {
  @ApiProperty({ required: false, enum: ['open', 'closed'], description: 'Only POs of one status' })
  @IsOptional()
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

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

/** One PO line as the reads return it — ordered / received / open always present. */
export class PurchaseOrderLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  poId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Ordered quantity in base UoM', minimum: 1 })
  orderedQty!: number;

  @ApiProperty({ description: 'Received-to-date in base UoM (0 until 3.3 receipts land)', minimum: 0 })
  receivedQty!: number;

  @ApiProperty({
    description: 'Derived: orderedQty − receivedQty (may go negative after an approved over-receipt — Story 3.3 relaxes the 3.1 `minimum: 0` bound)',
  })
  openQty!: number;

  @ApiProperty({ description: 'Unit cost as integer paise' })
  unitCostPaise!: number;

  @ApiProperty({ type: String, nullable: true, description: 'Expected receipt date (ISO-8601 UTC), null when unset' })
  expectedDate!: string | null;

  @ApiProperty({ description: 'Line status: open, or the close disposition (cancelled / carried)' })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;
}

/** One purchase order of the list / detail / mutation responses. */
export class PurchaseOrderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ description: 'PO code (unique per tenant)' })
  code!: string;

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The closed PO whose open quantities this successor carries (null on an original PO)',
  })
  carriedFromPoId!: string | null;

  @ApiProperty({ type: [PurchaseOrderLineDto], description: 'Per-line ordered / received / open (detail and mutations; headers only on the list)' })
  lines?: readonly PurchaseOrderLineDto[];

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last-mutation time' })
  updatedAt!: string;
}

export class PurchaseOrderResponse {
  @ApiProperty({ type: PurchaseOrderDto })
  purchaseOrder!: PurchaseOrderDto;
}

export class PurchaseOrderListResponse {
  @ApiProperty({ type: [PurchaseOrderDto] })
  items!: readonly PurchaseOrderDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

/** POST …/close response — the closed PO plus the auto-created successor (null when nothing was carried). */
export class PurchaseOrderCloseResponse {
  @ApiProperty({ type: PurchaseOrderDto })
  purchaseOrder!: PurchaseOrderDto;

  @ApiProperty({ type: PurchaseOrderDto, nullable: true })
  successor!: PurchaseOrderDto | null;
}