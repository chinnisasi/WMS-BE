import { Type } from 'class-transformer';
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
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EWAY_BLOCKERS, TRANS_MODES, VEHICLE_TYPES } from '../modules/invoicing/eway-json';
import type { EwayBlockerCode } from '../modules/invoicing/eway-json';
import { EWAY_BILL_STATUSES, EWAY_LIST_MAX_PAGE_SIZE, EWAY_SOURCES } from '../modules/invoicing/eway-view';
import type { EwayBillStatus, EwaySource } from '../modules/invoicing/eway-view';
import { EXPORT_MAX_BILLS } from '../modules/invoicing/eway.command';
import { GSTIN_RE } from '../shared/primitives/gstin';

// ── inputs ───────────────────────────────────────────────────────────────────

export class EwayBillListQuery {
  @ApiProperty({ required: false, enum: EWAY_BILL_STATUSES, description: 'Only bills in this status' })
  @IsOptional()
  @IsIn(EWAY_BILL_STATUSES)
  status?: EwayBillStatus;

  @ApiProperty({ required: false, description: 'Only bills of this supplier GSTIN (exact)' })
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE)
  gstin?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: EWAY_LIST_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EWAY_LIST_MAX_PAGE_SIZE)
  limit?: number;
}

/** PATCH body: the WHOLE Part B, replaced (null or absent clears a field). */
export class UpdateEwayTransportDto {
  @ApiProperty({ required: false, type: Number, nullable: true, enum: [...TRANS_MODES, null], description: '1 Road, 2 Rail, 3 Air, 4 Ship — required when any field is set' })
  @IsOptional()
  @IsInt()
  transMode?: number | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Road only: 4–15 letters or digits (uppercased, spaces removed)' })
  @IsOptional()
  @IsString()
  vehicleNo?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, enum: [...VEHICLE_TYPES, null], description: 'R regular / O over-dimensional — required with a vehicle' })
  @IsOptional()
  @IsString()
  vehicleType?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: "The transporter's GSTIN or TRANSIN (15 characters) — enough on its own for a Part-A-only bill" })
  @IsOptional()
  @IsString()
  transporterId?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'At most 25 characters' })
  @IsOptional()
  @IsString()
  transporterName?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Rail/Air/Ship: required, at most 15 characters' })
  @IsOptional()
  @IsString()
  transDocNo?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'YYYY-MM-DD, on or after the invoice date; Rail/Air/Ship: required' })
  @IsOptional()
  @IsString()
  transDocDate?: string | null;

  @ApiProperty({ required: false, type: Number, nullable: true, minimum: 0, maximum: 4000, description: 'Approximate distance in km (0 lets NIC compute it; at most 100 when both pincodes are equal)' })
  @IsOptional()
  @IsInt()
  distanceKm?: number | null;
}

export class RecordEwayDto {
  @ApiProperty({ description: 'The 12-digit EWB number the portal returned', example: '141234567890' })
  @IsString()
  ewbNo!: string;

  @ApiProperty({ description: 'When the portal generated it — ISO-8601 UTC, between the invoice issue and now (+5 min)' })
  @IsString()
  generatedAt!: string;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Validity end, ISO-8601 UTC, ≥ generatedAt (absent for a Part-A-only bill)' })
  @IsOptional()
  @IsString()
  validUntil?: string | null;
}

export class DismissEwayDto {
  @ApiProperty({ description: 'Why no e-way bill is needed (1–200 characters)' })
  @IsString()
  reason!: string;
}

export class ExportEwayDto {
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, maxItems: EXPORT_MAX_BILLS, description: 'Ready bills of ONE supplier GSTIN, no repeats' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EXPORT_MAX_BILLS)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class AppendEwayStateThresholdDto {
  @ApiProperty({ description: 'Two-digit GST state code (not 97 or 99)', example: '27' })
  @IsString()
  stateCode!: string;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: 'Intra-state threshold in paise; null = no e-way bill required for intra-state supply' })
  @ValidateIf((dto: AppendEwayStateThresholdDto) => dto.thresholdPaise !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  thresholdPaise!: number | null;

  @ApiProperty({ description: 'YYYY-MM-DD — applies to invoices issued (IST) on or after this date', example: '2026-04-01' })
  @IsString()
  effectiveFrom!: string;
}

export class PutEwayGstinSettingDto {
  @ApiProperty({ description: "E-invoicing applies to this GSTIN: its B2B bills are held as needs-irn" })
  @IsBoolean()
  eInvoiceApplies!: boolean;
}

// ── responses ────────────────────────────────────────────────────────────────

export class EwayTransportDto {
  @ApiProperty({ type: Number, nullable: true, enum: [...TRANS_MODES, null] })
  transMode!: number | null;

  @ApiProperty({ type: String, nullable: true })
  vehicleNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  vehicleType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transDocNo!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'YYYY-MM-DD' })
  transDocDate!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  distanceKm!: number | null;
}

export class EwayBlockerDto {
  @ApiProperty({ enum: EWAY_BLOCKERS })
  code!: EwayBlockerCode;

  @ApiProperty({ description: 'Terminal: the invoice is frozen — generate on the portal and record the number here. Otherwise fixable.' })
  terminal!: boolean;
}

export class EwayBillDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({ type: String, nullable: true })
  invoiceNo!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Invoice issue instant, ISO-8601 UTC' })
  invoiceIssuedAt!: string | null;

  @ApiProperty({ description: 'Supplier GSTIN (bill-from)' })
  originGstin!: string;

  @ApiProperty({ type: String, nullable: true })
  consigneeGstin!: string | null;

  @ApiProperty({ description: 'The consignee is registered (a GSTIN on the invoice)' })
  b2b!: boolean;

  @ApiProperty({ enum: EWAY_BILL_STATUSES })
  status!: EwayBillStatus;

  @ApiProperty({ description: 'Σ (taxable + CGST + SGST + IGST) over taxable lines, paise' })
  consignmentValuePaise!: number;

  @ApiProperty({ description: 'The threshold the value exceeded, paise' })
  thresholdPaise!: number;

  @ApiProperty({ description: "'national' or 'state:<code>'" })
  thresholdRule!: string;

  @ApiProperty({ type: EwayTransportDto })
  transport!: EwayTransportDto;

  @ApiProperty({ type: String, nullable: true })
  ewbNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ewbGeneratedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ewbValidUntil!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...EWAY_SOURCES, null] })
  source!: EwaySource | null;

  @ApiProperty({ type: String, nullable: true })
  dismissedReason!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The gateway's last refusal" })
  lastError!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gatewayClaimedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Last NIC JSON download that included this bill' })
  lastExportedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  lastExportedBy!: string | null;

  @ApiProperty({ type: [EwayBlockerDto], description: 'Computed at read time (pending bills only)' })
  blockers!: EwayBlockerDto[];

  @ApiProperty({ description: 'A gateway is configured for this GSTIN and the bill is pending (offer Generate)' })
  gatewayAvailable!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class EwayBillListResponse {
  @ApiProperty({ type: [EwayBillDto] })
  items!: EwayBillDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class EwayBillResponse {
  @ApiProperty({ type: EwayBillDto })
  bill!: EwayBillDto;
}

export class EwayExportResponse {
  @ApiProperty({
    type: Object,
    description: "The NIC bulk-upload file: { version, billLists: [bill objects] } — upload it as-is on the e-way portal's bulk generation",
  })
  file!: Record<string, unknown>;
}

export class EwayStateThresholdDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  stateCode!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'null = no e-way bill required' })
  thresholdPaise!: number | null;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  effectiveFrom!: string;

  @ApiProperty({ format: 'uuid' })
  createdBy!: string;

  @ApiProperty()
  createdAt!: string;
}

export class EwayStateThresholdListResponse {
  @ApiProperty({ type: [EwayStateThresholdDto] })
  items!: EwayStateThresholdDto[];
}

export class EwayStateThresholdResponse {
  @ApiProperty({ type: EwayStateThresholdDto })
  threshold!: EwayStateThresholdDto;
}

export class EwayGstinSettingDto {
  @ApiProperty()
  gstin!: string;

  @ApiProperty()
  eInvoiceApplies!: boolean;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  updatedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  updatedAt!: string | null;
}

export class EwayGstinSettingListResponse {
  @ApiProperty({ type: [EwayGstinSettingDto] })
  items!: EwayGstinSettingDto[];
}

export class EwayGstinSettingResponse {
  @ApiProperty({ type: EwayGstinSettingDto })
  setting!: EwayGstinSettingDto;
}
