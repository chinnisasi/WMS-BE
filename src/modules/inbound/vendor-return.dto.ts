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
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE, MIN_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import { RTV_BRAND_DOCUMENT_TYPES, type BrandDocumentType } from '../../shared/primitives/consignment-capture';
import { PartnerAddressDto, VendorSnapshotDto } from '../partners/partners.dto';
import {
  MAX_RTV_LINES,
  MAX_RTV_NOTE,
  RTV_CONSIGNEE_ADDRESS_KINDS,
  RTV_REASON_CODES,
  RTV_SOURCE_KINDS,
  VENDOR_RETURN_STATUSES,
  type RtvConsigneeAddressKind,
  type RtvReasonCode,
  type RtvSourceKind,
  type VendorReturnStatus,
} from './vendor-return.command';

// ── inputs ───────────────────────────────────────────────────────────────────

/** One line of a new return to vendor. */
export class CreateVendorReturnLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, required: false, description: 'The batch — required for a batch-tracked SKU, absent (or null) otherwise' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  batchId?: string | null;

  @ApiProperty({
    format: 'uuid',
    type: String,
    nullable: true,
    required: false,
    description:
      "Optional — the GRN line the damaged units came from (receipt damage or a receipt hold's QC fail): the vendor's debit-note source. It must be this warehouse's, of the same SKU and batch, and of a PO of this vendor when it has one",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  grnLineId?: string | null;

  @ApiProperty({ description: `Units to return (> 0). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: MIN_QUANTITY_BASE, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(MIN_QUANTITY_BASE)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;

  @ApiProperty({ enum: [...RTV_REASON_CODES], description: 'Why the units go back (`other` needs the note)' })
  @IsIn([...RTV_REASON_CODES])
  reasonCode!: RtvReasonCode;
}

/** POST /tenants/{tenantId}/vendor-returns — create a return to vendor (`rtv.manage`). */
export class CreateVendorReturnDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse whose DAMAGED stock goes back' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The vendor (a partner with the vendor role, actively linked to the SKUs\' client)' })
  @IsUUID()
  vendorId!: string;

  @ApiProperty({ enum: [...RTV_CONSIGNEE_ADDRESS_KINDS], description: "Which of the vendor's addresses the goods go to — frozen with the vendor; refused when the vendor has none of that kind" })
  @IsIn([...RTV_CONSIGNEE_ADDRESS_KINDS])
  consigneeAddress!: RtvConsigneeAddressKind;

  @ApiProperty({ type: String, nullable: true, required: false, maxLength: MAX_RTV_NOTE, description: 'A note printed on the dispatch note (trimmed; required when a line\'s reason is `other`)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  note?: string | null;

  @ApiProperty({ type: [CreateVendorReturnLineDto], minItems: 1, maxItems: MAX_RTV_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RTV_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateVendorReturnLineDto)
  lines!: CreateVendorReturnLineDto[];
}

/** One picked line of the handheld's `rtv.pick`. */
export class PickVendorReturnLineDto {
  @ApiProperty({ format: 'uuid', description: 'The RTV line' })
  @IsUUID()
  lineId!: string;

  @ApiProperty({ description: `Units picked (0 up to the line's quantity — a short pick is allowed). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  pickedQty!: number;
}

/** POST /tenants/{tenantId}/vendor-returns/{id}/pick — the handheld's `rtv.pick` (badge-in session). */
export class PickVendorReturnDto {
  @ApiProperty({ format: 'uuid', description: "The device's warehouse — an RTV of another warehouse answers 404" })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: 'When the operator confirmed the pick on the device (ISO-8601 UTC)' })
  @IsString()
  occurredAt!: string;

  @ApiProperty({ type: [PickVendorReturnLineDto], minItems: 1, maxItems: MAX_RTV_LINES, description: "Every line of the RTV, exactly once" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RTV_LINES)
  @ValidateNested({ each: true })
  @Type(() => PickVendorReturnLineDto)
  lines!: PickVendorReturnLineDto[];
}

/** The brand's movement document the goods travel under. */
export class BrandDocumentDto {
  @ApiProperty({ enum: [...RTV_BRAND_DOCUMENT_TYPES], description: "The brand's delivery challan, or its invoice" })
  @IsString()
  type!: string;

  @ApiProperty({ description: 'The document number (1–40 characters)', maxLength: 40 })
  @IsString()
  number!: string;

  @ApiProperty({ description: 'The document date (YYYY-MM-DD, IST) — no later than today and no earlier than 30 days before the RTV was created' })
  @IsString()
  date!: string;
}

/** POST /tenants/{tenantId}/vendor-returns/{id}/dispatch — the web dispatch (`dispatch.execute`). */
export class DispatchVendorReturnDto {
  @ApiProperty({ type: BrandDocumentDto, description: "Required — goods cannot travel without the brand's challan or invoice" })
  @IsOptional()
  @ValidateNested()
  @Type(() => BrandDocumentDto)
  brandDocument?: BrandDocumentDto;

  @ApiProperty({ type: String, nullable: true, required: false, description: "The brand registration the challan names (e.g. its additional place of business in the warehouse's state); defaults to the brand's frozen GSTIN" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  consignorGstin?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: "The brand's debit-note (claim) reference, printed (≤ 40)" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  debitNoteNumber?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The e-way bill number (12 digits) — recorded, never generated; its date is required with it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  ewayBillNumber?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The e-way bill date (YYYY-MM-DD)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  ewayBillDate?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The e-way bill validity (YYYY-MM-DD, on or after its date)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  ewayValidUntil?: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, required: false, description: 'A transporter partner (frozen at dispatch). At least one of transporterId, carrierName, vehicleNumber' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  transporterId?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The carrier, typed (≤ 100)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  carrierName?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The vehicle registration (spaces, dots and hyphens ignored; 4–15 letters and digits)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  vehicleNumber?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'The AWB or LR number (≤ 50)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  trackingRef?: string | null;

  @ApiProperty({ type: Number, required: false, description: 'Required — the number of packages (1–9999)', minimum: 1, maximum: 9999 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  packageCount?: number;
}

/** POST /tenants/{tenantId}/vendor-returns/{id}/cancel (`rtv.manage`). */
export class CancelVendorReturnDto {
  @ApiProperty({ description: 'Why the return is cancelled (1–500 characters, trimmed)', maxLength: MAX_RTV_NOTE })
  @IsString()
  reason!: string;
}

export class VendorReturnListQuery {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...VENDOR_RETURN_STATUSES] })
  @IsOptional()
  @IsIn([...VENDOR_RETURN_STATUSES])
  status?: VendorReturnStatus;

  @ApiProperty({ required: false, description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ReturnableDamagedQuery {
  @ApiProperty({ format: 'uuid', description: "The client whose DAMAGED stock is listed (a return to vendor is one client's)" })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Only this SKU' })
  @IsOptional()
  @IsUUID()
  skuId?: string;
}

// ── responses ────────────────────────────────────────────────────────────────

export class ClientPartySnapshotDto {
  @ApiProperty({ enum: [1] })
  v!: 1;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  legalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: PartnerAddressDto, nullable: true })
  registeredAddress!: PartnerAddressDto | null;
}

export class RtvOriginAddressDto {
  @ApiProperty()
  contactName!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty()
  line1!: string;

  @ApiProperty({ type: String, nullable: true })
  line2!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  state!: string;

  @ApiProperty()
  pincode!: string;
}

/** The warehouse the goods leave from — frozen at dispatch, the live row before (`frozen`). */
export class RtvWarehousePartyDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: RtvOriginAddressDto, nullable: true })
  originAddress!: RtvOriginAddressDto | null;

  @ApiProperty({ description: 'The 3PL operating the warehouse (the tenant) — the note reads "Dispatched from — operated by <operatorName>"' })
  operatorName!: string;

  @ApiProperty({ description: 'True once dispatched (the values were frozen then); false before — the live warehouse' })
  frozen!: boolean;
}

export class RtvActorStampDto {
  @ApiProperty({ format: 'uuid' })
  by!: string;

  @ApiProperty({ type: String, nullable: true, description: "The member's display name; null when no longer a member" })
  byName!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  at!: string;
}

export class RtvPickStampDto extends RtvActorStampDto {
  @ApiProperty({ format: 'uuid', description: 'The handheld that picked it' })
  deviceId!: string;
}

export class RtvBrandDocumentDto {
  @ApiProperty({ enum: [...RTV_BRAND_DOCUMENT_TYPES] })
  type!: BrandDocumentType;

  @ApiProperty()
  number!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  date!: string;
}

export class RtvEwayBillDto {
  @ApiProperty()
  number!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  date!: string;

  @ApiProperty({ type: String, nullable: true, description: 'YYYY-MM-DD' })
  validUntil!: string | null;
}

export class RtvDispatchDto extends RtvActorStampDto {
  @ApiProperty({ type: RtvBrandDocumentDto })
  brandDocument!: RtvBrandDocumentDto;

  @ApiProperty({ type: String, nullable: true, description: "The GSTIN the challan names — as entered at dispatch, else the brand's frozen GSTIN (null when it has none)" })
  consignorGstin!: string | null;

  @ApiProperty({ type: String, nullable: true })
  debitNoteNumber!: string | null;

  @ApiProperty({ type: RtvEwayBillDto, nullable: true })
  ewayBill!: RtvEwayBillDto | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  transporterId!: string | null;

  @ApiProperty({ type: VendorSnapshotDto, nullable: true, description: 'The transporter partner as frozen at dispatch' })
  transporter!: VendorSnapshotDto | null;

  @ApiProperty({ type: String, nullable: true })
  carrierName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  vehicleNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The AWB or LR number' })
  trackingRef!: string | null;

  @ApiProperty()
  packageCount!: number;
}

export class RtvCancelDto extends RtvActorStampDto {
  @ApiProperty()
  reason!: string;
}

export class RtvLineSourceDto {
  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  grnId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  grnCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The PO the GRN was received against (null on an ASN or a blind receipt)' })
  poCode!: string | null;
}

export class VendorReturnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '1-based, in the document\'s canonical order' })
  lineNo!: number;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Frozen at create' })
  skuCode!: string;

  @ApiProperty({ description: 'Frozen at create' })
  skuName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Frozen at create' })
  hsn!: string | null;

  @ApiProperty({ description: 'The base unit, frozen at create' })
  uom!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Frozen at create' })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The batch expiry (ISO-8601 UTC), frozen at create' })
  batchExpiry!: string | null;

  @ApiProperty({ enum: [...RTV_REASON_CODES] })
  reasonCode!: RtvReasonCode;

  @ApiProperty({ description: `Units to return. ${QUANTITY_FIELD_DESCRIPTION}` })
  quantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Units picked on the handheld (null until the pick)' })
  pickedQuantity!: number | null;

  @ApiProperty({ type: RtvLineSourceDto, nullable: true, description: 'The GRN line the units came from (null when the line names none)' })
  source!: RtvLineSourceDto | null;
}

/** One return to vendor, as every command answers it and the detail reads it. */
export class VendorReturnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'RTV-0001' })
  code!: string;

  @ApiProperty({ enum: [...VENDOR_RETURN_STATUSES] })
  status!: VendorReturnStatus;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: RtvWarehousePartyDto, description: 'Dispatched from — frozen at dispatch, live before' })
  warehouse!: RtvWarehousePartyDto;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ type: ClientPartySnapshotDto, description: 'The brand (the consignor), frozen at create' })
  client!: ClientPartySnapshotDto;

  @ApiProperty({ format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ type: VendorSnapshotDto, description: 'The vendor (the consignee), frozen at create' })
  vendor!: VendorSnapshotDto;

  @ApiProperty({ enum: [...RTV_CONSIGNEE_ADDRESS_KINDS] })
  consigneeAddressKind!: RtvConsigneeAddressKind;

  @ApiProperty({ type: PartnerAddressDto, description: "The vendor's frozen address the goods go to (the kind chosen at create)" })
  consigneeAddress!: PartnerAddressDto;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: RtvActorStampDto, description: 'Who created it and when' })
  created!: RtvActorStampDto;

  @ApiProperty({ type: RtvPickStampDto, nullable: true })
  picked!: RtvPickStampDto | null;

  @ApiProperty({ type: RtvDispatchDto, nullable: true })
  dispatch!: RtvDispatchDto | null;

  @ApiProperty({ type: RtvCancelDto, nullable: true })
  cancellation!: RtvCancelDto | null;

  @ApiProperty({ type: [VendorReturnLineDto] })
  lines!: VendorReturnLineDto[];

  @ApiProperty({ description: 'Σ line quantities (base units — lines may be of different units; the per-line figures are authoritative)' })
  totalQuantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Σ picked quantities (null until the pick)' })
  totalPickedQuantity!: number | null;
}

export class VendorReturnSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...VENDOR_RETURN_STATUSES] })
  status!: VendorReturnStatus;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: "The brand's frozen code" })
  clientCode!: string;

  @ApiProperty({ description: "The brand's frozen name" })
  clientName!: string;

  @ApiProperty({ format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ description: "The vendor's frozen name" })
  vendorName!: string;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Σ line quantities (base units)' })
  totalQuantity!: number;

  @ApiProperty({ type: Number, nullable: true })
  totalPickedQuantity!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'The AWB or LR number once dispatched' })
  trackingRef!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The brand's challan or invoice number once dispatched" })
  brandDocumentNumber!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC (the keyset field)' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  pickedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  dispatchedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;
}

export class VendorReturnListResponse {
  @ApiProperty({ type: [VendorReturnSummaryDto] })
  items!: VendorReturnSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** One GRN line DAMAGED units of an arm came from — a candidate source. */
export class ReturnableSourceDto {
  @ApiProperty({ enum: [...RTV_SOURCE_KINDS], description: '`receipt-damage` when the line booked damage at receipt, else `qc-fail` (its receipt hold failed inspection)' })
  kind!: RtvSourceKind;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty()
  grnCode!: string;

  @ApiProperty({ type: String, nullable: true })
  poCode!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: "The PO's vendor — the only vendor this source can go back to (null on an ASN or a blind receipt: any linked vendor)" })
  vendorId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The PO's frozen vendor name" })
  vendorName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The damage reason at receipt, else the first QC fail reason' })
  reason!: string | null;

  @ApiProperty({ description: 'Units booked damaged at receipt' })
  receiptDamagedQty!: number;

  @ApiProperty({ description: "Units the line's receipt holds failed at inspection" })
  qcFailedQty!: number;

  @ApiProperty({ description: 'Units every non-cancelled return to vendor already names (dispatched included)' })
  claimedQty!: number;

  @ApiProperty({ description: "min(the line's remaining, the arm's available)" })
  claimableQty!: number;

  @ApiProperty({ description: 'When the units last landed in DAMAGED (ISO-8601 UTC)' })
  receivedAt!: string;
}

export class ReturnableArmDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'The decimal places the unit admits' })
  uomPrecision!: number;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' })
  batchExpiry!: string | null;

  @ApiProperty({ description: 'On hand in DAMAGED' })
  onHand!: number;

  @ApiProperty({ description: 'Claimed by open returns to vendor (draft quantity, picked quantity)' })
  claimed!: number;

  @ApiProperty({ type: [String], description: 'The open RTVs claiming it' })
  claimedBy!: string[];

  @ApiProperty({ description: 'onHand − claimed (never below 0)' })
  available!: number;

  @ApiProperty({ type: [ReturnableSourceDto], description: 'The GRN lines with claimable units, newest first (at most 20)' })
  sources!: ReturnableSourceDto[];
}

export class ReturnableDamagedResponse {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: 'True when a cap bit (500 arms, 20 sources per arm) — narrow by skuId' })
  truncated!: boolean;

  @ApiProperty({ type: [ReturnableArmDto] })
  arms!: ReturnableArmDto[];
}
