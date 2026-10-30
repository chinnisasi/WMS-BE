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
import { MAX_QUANTITY_BASE, MIN_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../shared/primitives/quantity';
import { RTV_BRAND_DOCUMENT_TYPES, type BrandDocumentType } from '../shared/primitives/consignment-capture';
import { VendorSnapshotDto } from '../modules/partners/partners.dto';
import {
  BrandDocumentDto,
  ClientPartySnapshotDto,
  EwayExemptionDto,
  RtvActorStampDto,
  RtvBrandDocumentDto,
  RtvCancelDto,
  RtvEwayBillDto,
  RtvPickStampDto,
  RtvWarehousePartyDto,
} from '../modules/inbound/vendor-return.dto';
import { AwaitingDispositionDto } from '../modules/returns/returns.dto';
import {
  CLIENT_RETURN_STATUSES,
  MAX_DECLARED_VALUE_PAISE,
  MAX_RTC_LINES,
  MAX_RTC_NOTE,
  RETURN_CONDITIONS,
  RETURN_DISPOSITION_REASONS,
  RTC_ADDRESS_KINDS,
  RTC_LINE_SOURCES,
  type ClientReturnStatus,
  type ReturnCondition,
  type ReturnDispositionReason,
  type RtcAddressKind,
  type RtcLineSource,
} from '../modules/returns/returns.facade';

/**
 * Story 4-7c — the return-to-client wire shapes. They live in the api shell
 * so the response reuses 2-8b's shared party, stamp and capture classes
 * (one generated type for both documents — the web's shared dispatch form
 * and note read them); the returns module may not import inbound's DTOs.
 */

// ── inputs ───────────────────────────────────────────────────────────────────

/** One line of a new return to client. */
export class CreateClientReturnLineDto {
  @ApiProperty({ enum: [...RTC_LINE_SOURCES], description: '`returns` — a receipt line awaiting disposition (RETURNS); `damaged` — a DAMAGED arm of the client' })
  @IsIn([...RTC_LINE_SOURCES])
  source!: RtcLineSource;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, required: false, description: 'A returns line: the 4-7a receipt line (its SKU, batch, serial and RMA come from it). Absent on a damaged line' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  returnReceiptLineId?: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, required: false, description: 'A damaged line: the SKU. Absent on a returns line' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  skuId?: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, required: false, description: 'A damaged line: the batch — required for a batch-tracked SKU, absent otherwise' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  batchId?: string | null;

  @ApiProperty({ description: `Units to return (> 0; a serial line is 1). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: MIN_QUANTITY_BASE, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(MIN_QUANTITY_BASE)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;

  @ApiProperty({ enum: [...RETURN_DISPOSITION_REASONS], required: false, description: 'Why the units go back — defaults to `client-instruction` (`other` needs the note)' })
  @IsOptional()
  @IsIn([...RETURN_DISPOSITION_REASONS])
  reasonCode?: ReturnDispositionReason;
}

/** POST /tenants/{tenantId}/client-returns — create a return to client (`returns.manage`). */
export class CreateClientReturnDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the goods leave from' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    enum: [...RTC_ADDRESS_KINDS],
    required: false,
    default: 'return',
    description: "Which of the client's addresses the goods go to — frozen at create; refused (409 client-address-missing) when the client has none of that kind",
  })
  @IsOptional()
  @IsIn([...RTC_ADDRESS_KINDS])
  consigneeAddress?: RtcAddressKind;

  @ApiProperty({ type: String, nullable: true, required: false, maxLength: MAX_RTC_NOTE, description: "A note printed on the dispatch note (trimmed; required when a line's reason is `other`)" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  note?: string | null;

  @ApiProperty({ type: [CreateClientReturnLineDto], minItems: 1, maxItems: MAX_RTC_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RTC_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateClientReturnLineDto)
  lines!: CreateClientReturnLineDto[];
}

/** One picked line of the handheld's `rtc.pick`. */
export class PickClientReturnLineDto {
  @ApiProperty({ format: 'uuid', description: 'The RTC line' })
  @IsUUID()
  lineId!: string;

  @ApiProperty({ description: `Units picked (0 up to the line's quantity; a serial line 0 or 1). ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  pickedQty!: number;
}

/** POST /tenants/{tenantId}/client-returns/{id}/pick — the handheld's `rtc.pick` (badge-in session). */
export class PickClientReturnDto {
  @ApiProperty({ format: 'uuid', description: "The device's warehouse — an RTC of another warehouse answers 404" })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: 'When the operator confirmed the pick on the device (ISO-8601 UTC)' })
  @IsString()
  occurredAt!: string;

  @ApiProperty({ type: [PickClientReturnLineDto], minItems: 1, maxItems: MAX_RTC_LINES, description: 'Every line of the RTC, exactly once' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RTC_LINES)
  @ValidateNested({ each: true })
  @Type(() => PickClientReturnLineDto)
  lines!: PickClientReturnLineDto[];
}

/** POST /tenants/{tenantId}/client-returns/{id}/dispatch — the web dispatch (`dispatch.execute`). No debit note (D8). */
export class DispatchClientReturnDto {
  @ApiProperty({ type: BrandDocumentDto, description: "Required — the brand's delivery challan (same state) or its stock-transfer invoice (another state)" })
  @IsOptional()
  @ValidateNested()
  @Type(() => BrandDocumentDto)
  brandDocument?: BrandDocumentDto;

  @ApiProperty({ type: String, nullable: true, required: false, description: "The brand registration the challan names at the warehouse's state; defaults to the brand's frozen GSTIN" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  consignorGstin?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: "A2 — the brand registration that receives the goods; defaults to the brand's frozen GSTIN ('Unregistered' when it has none)" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  consigneeGstin?: string | null;

  @ApiProperty({ type: Number, nullable: true, required: false, minimum: 0, maximum: MAX_DECLARED_VALUE_PAISE, description: "A9 — the consignor's declared value in paise, printed \"declared by the consignor\" and judged against the e-way threshold (4-6a): above it an e-way bill number or an exemption is required. Optional on the API for older callers; the web always sends it" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  declaredValuePaise?: number | null;

  @ApiProperty({ type: () => EwayExemptionDto, nullable: true, required: false, description: 'Story 4-6a — instead of an e-way bill above the threshold' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => EwayExemptionDto)
  ewayExemption?: EwayExemptionDto | null;

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

/** POST /tenants/{tenantId}/client-returns/{id}/cancel (`returns.manage`). */
export class CancelClientReturnDto {
  @ApiProperty({ description: 'Why the return is cancelled (1–500 characters, trimmed)', maxLength: MAX_RTC_NOTE })
  @IsString()
  reason!: string;
}

export class ClientReturnListQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...CLIENT_RETURN_STATUSES] })
  @IsOptional()
  @IsIn([...CLIENT_RETURN_STATUSES])
  status?: ClientReturnStatus;

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

export class ReturnableToClientQuery {
  @ApiProperty({ format: 'uuid', description: 'The client whose returned and damaged units are listed (a return to client is one client\'s)' })
  @IsUUID()
  clientId!: string;
}

// ── responses ────────────────────────────────────────────────────────────────

/** A2 — the consignee address, frozen at create (every key present). */
export class ConsigneeAddressDto {
  @ApiProperty({ enum: [...RTC_ADDRESS_KINDS] })
  kind!: RtcAddressKind;

  @ApiProperty({ type: String, nullable: true, description: 'The return address\'s contact (null from the registered address)' })
  contactName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty()
  line1!: string;

  @ApiProperty({ type: String, nullable: true })
  line2!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The return address\'s state as typed (free text); null from the registered address' })
  state!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The registered address\'s GST state code; null from the return address (it stores the state as free text)' })
  stateCode!: string | null;

  @ApiProperty()
  pincode!: string;
}

export class ClientReturnDispatchDto extends RtvActorStampDto {
  @ApiProperty({ type: RtvBrandDocumentDto })
  brandDocument!: RtvBrandDocumentDto;

  @ApiProperty({ type: String, nullable: true, description: "As entered at dispatch, else the brand's frozen GSTIN; null when neither" })
  consignorGstin!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "A2 — as entered at dispatch, else the brand's frozen GSTIN; null when neither (the note prints \"Unregistered\")" })
  consigneeGstin!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'The declared value in paise, as entered' })
  declaredValuePaise!: number | null;

  @ApiProperty({ required: false, description: 'Story 4-6a — true when no value was sent, so the e-way threshold was not judged (an older caller)' })
  ewayUnjudged?: boolean;

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

export class ClientReturnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: "1-based, in the document's canonical order" })
  lineNo!: number;

  @ApiProperty({ enum: [...RTC_LINE_SOURCES] })
  source!: RtcLineSource;

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

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' })
  batchExpiry!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'A serial line (returns only): the unit' })
  serialId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The serial the pick must scan' })
  serialNumber!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'A returns line: the receipt line it claims' })
  returnReceiptLineId!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  rmaId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'RMA-0001 (returns lines)' })
  rmaCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The RMA's order reference (returns lines)" })
  orderReference!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...RETURN_CONDITIONS, null], description: 'The receipt grade (returns lines); null on a damaged line' })
  condition!: ReturnCondition | null;

  @ApiProperty({ enum: [...RETURN_DISPOSITION_REASONS] })
  reasonCode!: ReturnDispositionReason;

  @ApiProperty({ description: `Units to return. ${QUANTITY_FIELD_DESCRIPTION}` })
  quantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Units picked on the handheld (null until the pick)' })
  pickedQuantity!: number | null;
}

/** One return to client, as every command answers it and the detail reads it. */
export class ClientReturnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'RTC-0001' })
  code!: string;

  @ApiProperty({ enum: [...CLIENT_RETURN_STATUSES] })
  status!: ClientReturnStatus;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: RtvWarehousePartyDto, description: 'Dispatched from — frozen at dispatch, live before' })
  warehouse!: RtvWarehousePartyDto;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ type: ClientPartySnapshotDto, description: 'The brand (consignor and consignee), frozen at create' })
  client!: ClientPartySnapshotDto;

  @ApiProperty({ enum: [...RTC_ADDRESS_KINDS] })
  consigneeAddressKind!: RtcAddressKind;

  @ApiProperty({ type: ConsigneeAddressDto, description: "The client's frozen address the goods go to" })
  consigneeAddress!: ConsigneeAddressDto;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: RtvActorStampDto })
  created!: RtvActorStampDto;

  @ApiProperty({ type: RtvPickStampDto, nullable: true })
  picked!: RtvPickStampDto | null;

  @ApiProperty({ type: ClientReturnDispatchDto, nullable: true })
  dispatch!: ClientReturnDispatchDto | null;

  @ApiProperty({ type: RtvCancelDto, nullable: true })
  cancellation!: RtvCancelDto | null;

  @ApiProperty({ type: [ClientReturnLineDto] })
  lines!: ClientReturnLineDto[];

  @ApiProperty({ description: 'Σ line quantities (base units)' })
  totalQuantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Σ picked quantities (null until the pick)' })
  totalPickedQuantity!: number | null;
}

export class ClientReturnSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...CLIENT_RETURN_STATUSES] })
  status!: ClientReturnStatus;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: "The brand's frozen code" })
  clientCode!: string;

  @ApiProperty({ description: "The brand's frozen name" })
  clientName!: string;

  @ApiProperty({ enum: [...RTC_ADDRESS_KINDS] })
  consigneeAddressKind!: RtcAddressKind;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Σ line quantities (base units)' })
  totalQuantity!: number;

  @ApiProperty({ type: Number, nullable: true })
  totalPickedQuantity!: number | null;

  @ApiProperty({ type: String, nullable: true })
  trackingRef!: string | null;

  @ApiProperty({ type: String, nullable: true })
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

export class ClientReturnListResponse {
  @ApiProperty({ type: [ClientReturnSummaryDto] })
  items!: ClientReturnSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class ReturnableToClientArmDto {
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

  @ApiProperty({ type: String, nullable: true })
  batchExpiry!: string | null;

  @ApiProperty({ description: 'On hand in DAMAGED' })
  onHand!: number;

  @ApiProperty({ description: 'Claimed by open returns to vendor' })
  claimedRtv!: number;

  @ApiProperty({ description: 'Claimed by open returns to client' })
  claimedRtc!: number;

  @ApiProperty({ type: [String], description: 'The open RTVs and RTCs claiming it' })
  claimedBy!: string[];

  @ApiProperty({ description: 'onHand − both claims (never below 0)' })
  available!: number;
}

export class ReturnableToClientResponse {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: 'True when a list hit its cap (500)' })
  truncated!: boolean;

  @ApiProperty({ type: [AwaitingDispositionDto], description: "The client's receipt lines awaiting disposition in the warehouse, oldest first (returned cases left out)" })
  awaiting!: AwaitingDispositionDto[];

  @ApiProperty({ type: [ReturnableToClientArmDto], description: "The client's DAMAGED arms an RTC can carry (no serial, catch-weight or kit SKU)" })
  damaged!: ReturnableToClientArmDto[];
}

// ── the client portal (decision 15) — an exact allowlist ─────────────────────

export class PortalClientReturnRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'RTC-0001' })
  code!: string;

  @ApiProperty({ enum: [...CLIENT_RETURN_STATUSES], description: 'draft and picked read "Being prepared", dispatched "Shipped" (A14)' })
  status!: ClientReturnStatus;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  dispatchedAt!: string | null;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Σ line quantities (base units)' })
  totalQuantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'What left, once dispatched' })
  shippedQuantity!: number | null;

  @ApiProperty({ type: String, nullable: true })
  carrierName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The AWB or LR number' })
  trackingRef!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  packageCount!: number | null;
}

export class PortalClientReturnPageResponse {
  @ApiProperty({ type: [PortalClientReturnRowDto] })
  items!: readonly PortalClientReturnRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalClientReturnLineDto {
  @ApiProperty()
  lineNo!: number;

  @ApiProperty({ enum: [...RTC_LINE_SOURCES] })
  source!: RtcLineSource;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serialNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rmaCode!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...RETURN_CONDITIONS, null] })
  condition!: ReturnCondition | null;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'What left on the line, once dispatched' })
  shippedQuantity!: number | null;
}

export class PortalBrandDocumentDto {
  @ApiProperty({ enum: [...RTV_BRAND_DOCUMENT_TYPES] })
  type!: BrandDocumentType;

  @ApiProperty()
  number!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  date!: string;
}

export class PortalClientReturnDetailResponse extends PortalClientReturnRowDto {
  @ApiProperty({ type: ConsigneeAddressDto })
  consigneeAddress!: ConsigneeAddressDto;

  @ApiProperty({ type: String, nullable: true })
  vehicleNumber!: string | null;

  @ApiProperty({ type: PortalBrandDocumentDto, nullable: true, description: 'Once dispatched' })
  brandDocument!: PortalBrandDocumentDto | null;

  @ApiProperty({ type: String, nullable: true })
  ewayBillNumber!: string | null;

  @ApiProperty({ type: [PortalClientReturnLineDto] })
  lines!: readonly PortalClientReturnLineDto[];
}
