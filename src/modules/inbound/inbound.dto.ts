import { Transform, Type } from 'class-transformer';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
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
import {
  ASN_STATUSES,
  MAX_ASN_CODE_LENGTH,
  MAX_ASN_LINES,
  MAX_ASN_NOTE_CODE_POINTS,
  type AsnStatus,
} from './asn.command';

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

  @ApiProperty({
    description: `Ordered quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
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

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'Story 21-2b — the client the PO is for, derived from its lines\' SKUs. Absent or null only on a replayed response stored before 21-2b',
  })
  clientId?: string | null;

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
// ── Advance shipment notices (story 21-6) ───────────────────────────────────

/** One ASN line as the client supplies it (create and amend). */
export class AsnLineInputDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Existing line to update (amend only) — omitted means a new line',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Announced quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  announcedQty!: number;
}

/** POST /tenants/{tenantId}/inbound/asns body. */
export class CreateAsnDto {
  @ApiProperty({ format: 'uuid', description: "The client the shipment is for — checked against the lines' SKUs" })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ format: 'uuid', description: 'The warehouse the shipment arrives at — fixed at create' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: "The client's own ASN code — unique per client; 1–64 characters, counted in code points", minLength: 1, maxLength: MAX_ASN_CODE_LENGTH })
  @Trim()
  @IsString()
  // Code points, not UTF-16 units (`@Length` would refuse a 64-character
  // code carrying astral characters that 0064's `char_length` CHECK admits).
  @Matches(new RegExp(`^.{1,${MAX_ASN_CODE_LENGTH}}$`, 'su'), {
    message: `asnCode must be 1–${MAX_ASN_CODE_LENGTH} characters`,
  })
  asnCode!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'When the shipment is expected (ISO-8601 UTC, Z-suffixed); optional',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  expectedAt?: string | null;

  @ApiProperty({ type: [AsnLineInputDto], minItems: 1, maxItems: MAX_ASN_LINES, description: 'At least one line with a known SKU of the client' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASN_LINES)
  @ValidateNested({ each: true })
  @Type(() => AsnLineInputDto)
  lines!: AsnLineInputDto[];
}

/** PATCH /tenants/{tenantId}/inbound/asns/{asnId} body — the full line set. */
export class AmendAsnDto {
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'Omitted: unchanged; null: cleared; otherwise an ISO-8601 UTC instant (Z-suffixed)',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  expectedAt?: string | null;

  @ApiProperty({
    type: [AsnLineInputDto],
    minItems: 1,
    maxItems: MAX_ASN_LINES,
    description:
      'The complete new line set (update by id, add without id, remove by absence). A line that has received anything cannot be removed, change SKU, or announce less than it received',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASN_LINES)
  @ValidateNested({ each: true })
  @Type(() => AsnLineInputDto)
  lines!: AsnLineInputDto[];
}

/** POST …/asns/{asnId}/close and /cancel body. */
export class AsnNoteDto {
  @ApiProperty({ description: `Why — required, 1–${MAX_ASN_NOTE_CODE_POINTS} characters`, minLength: 1, maxLength: MAX_ASN_NOTE_CODE_POINTS * 2 })
  @IsString()
  @Length(1, MAX_ASN_NOTE_CODE_POINTS * 2)
  note!: string;
}

/** Query of the warehouse ASN list. */
export class AsnListQuery {
  @ApiProperty({ required: false, enum: [...ASN_STATUSES], description: 'Only ASNs of one status' })
  @IsOptional()
  @IsIn([...ASN_STATUSES])
  status?: AsnStatus;

  @ApiProperty({ required: false, format: 'uuid', description: "Only one client's ASNs" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** One ASN line as the reads return it. */
export class AsnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Announced quantity in base UoM' })
  announcedQty!: number;

  @ApiProperty({ description: 'Received to date in base UoM', minimum: 0 })
  receivedQty!: number;

  @ApiProperty({ description: 'Derived: announcedQty − receivedQty (negative after an approved over-receipt)' })
  openQty!: number;
}

/** One ASN header of the warehouse list. */
export class AsnEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: "The client's ASN code" })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({
    enum: [...ASN_STATUSES],
    description: 'announced / partially_received / received are derived from the lines; closed (short) and cancelled are explicit',
  })
  status!: AsnStatus;

  @ApiProperty({ type: String, nullable: true, description: 'When the shipment is expected (ISO-8601 UTC), null when unset' })
  expectedAt!: string | null;

  @ApiProperty({ description: 'Number of lines' })
  lineCount!: number;

  @ApiProperty({ description: 'Lines whose received quantity has reached announced — the unit-safe progress figure ("N of M lines received")' })
  linesComplete!: number;

  @ApiProperty({ description: 'Σ announced over the lines, in base units — sums across UoMs, so indicative only' })
  announcedTotal!: number;

  @ApiProperty({ description: 'Σ received over the lines, in base units' })
  receivedTotal!: number;

  @ApiProperty({ description: 'ISO-8601 UTC creation time (the keyset field)' })
  createdAt!: string;
}

/** One ASN of the detail read and every mutation's response. */
export class AsnDto extends AsnEntryDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: String, nullable: true, description: "The close / cancel note — set exactly on those two statuses" })
  statusNote!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC last-mutation time' })
  updatedAt!: string;

  @ApiProperty({ type: [AsnLineDto], description: 'Per-line announced / received / open, oldest first' })
  lines!: readonly AsnLineDto[];
}

export class AsnResponse {
  @ApiProperty({ type: AsnDto })
  asn!: AsnDto;
}

export class AsnListResponse {
  @ApiProperty({ type: [AsnEntryDto] })
  items!: readonly AsnEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}
