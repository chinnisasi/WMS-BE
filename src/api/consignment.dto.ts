import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, ValidateIf, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  CONSIGNMENT_EWAY_STATUSES,
  CONSIGNMENT_RECORD_SOURCES,
  CONSIGNMENT_RECORD_STATUSES,
  EWAY_EXEMPTION_REASONS,
  ORDER_BRAND_DOCUMENT_TYPES,
} from '../shared/primitives/consignment-record';
import { CONSIGNMENT_GATE_CODES, CONSIGNMENT_GATE_STATES, CONSIGNMENT_REQUIRED_BECAUSE } from '../shared/primitives/consignment-gate';
import { CONSIGNMENT_DOCUMENT_RULES } from '../modules/clients/clients.schema';

/**
 * Story 4-6a — the consignment record's wire shapes (A9–A11, A16–A18). The
 * body fields are permissive here (strings, an integer): every shape rule is
 * the command's named 400 (`assertConsignmentRecordShape`), so the API and a
 * non-HTTP caller answer the same message.
 */

const nullableText = { type: String, nullable: true, required: false } as const;

export class ConsignmentBrandDocumentDto {
  @ApiProperty({ enum: [...ORDER_BRAND_DOCUMENT_TYPES], description: "The brand's tax invoice, delivery challan or bill of supply" })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ description: 'The document number (1–40 characters)', maxLength: 40 })
  @IsOptional()
  @IsString()
  number?: string;

  @ApiProperty({ description: "The document date (YYYY-MM-DD, IST) — no later than today and no earlier than 30 days before the order's creation day" })
  @IsOptional()
  @IsString()
  date?: string;
}

export class ConsignmentEwayBillInputDto {
  @ApiProperty({ description: "The brand's e-way bill number (12 digits) — recorded, never generated" })
  @IsOptional()
  @IsString()
  number?: string;

  @ApiProperty({ description: 'The e-way bill date (YYYY-MM-DD, IST): not before the document, not after today' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiProperty({ description: 'Its last valid day (YYYY-MM-DD) — required: the goods move, so Part B is filled (A34)' })
  @IsOptional()
  @IsString()
  validUntil?: string;
}

export class ConsignmentExemptionInputDto {
  @ApiProperty({ enum: [...EWAY_EXEMPTION_REASONS], description: 'Why no e-way bill is needed above the threshold (an office role on the staff surface — A46)' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Required for "other" (1–200)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  note?: string | null;
}

/** A9 — `POST …/outbound/orders/{orderId}/consignment` and its portal twin. */
export class RecordConsignmentDto {
  @ApiProperty({ type: ConsignmentBrandDocumentDto, description: "Required — the brand's tax document the goods travel under" })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsignmentBrandDocumentDto)
  brandDocument?: ConsignmentBrandDocumentDto;

  @ApiProperty({ ...nullableText, description: "The brand registration the document names (defaults to the client's GSTIN)" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  consignorGstin?: string | null;

  @ApiProperty({ type: Number, description: "Required — the consignment value on the brand's document, including tax, in paise (0–10^12); the e-way threshold is judged from it" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  declaredValuePaise?: number | null;

  @ApiProperty({ type: ConsignmentEwayBillInputDto, required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => ConsignmentEwayBillInputDto)
  ewayBill?: ConsignmentEwayBillInputDto | null;

  @ApiProperty({ type: ConsignmentExemptionInputDto, required: false, nullable: true, description: 'Instead of an e-way bill — never both' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => ConsignmentExemptionInputDto)
  ewayExemption?: ConsignmentExemptionInputDto | null;

  @ApiProperty({ ...nullableText, description: 'Why it is amended (1–200) — required once the order is dispatched' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  reason?: string | null;
}

/** A10 — `POST …/outbound/orders/{orderId}/consignment/withdraw`. */
export class WithdrawConsignmentDto {
  @ApiProperty({ description: 'Why the record is withdrawn (1–200)' })
  @IsString()
  reason!: string;
}

/** A11 — `PUT …/clients/{clientId}/consignment-policy`. */
export class ConsignmentPolicyDto {
  @ApiProperty({ enum: [...CONSIGNMENT_DOCUMENT_RULES], description: 'b2b: B2B orders (the default); all: every order; high-value: only the order’s own value above the e-way threshold' })
  @IsString()
  documentRule!: string;
}

export class ConsignmentPolicyResponse {
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_DOCUMENT_RULES] }) documentRule!: string;
}

// ── responses ────────────────────────────────────────────────────────────────

export class ConsignmentDocumentViewDto {
  @ApiProperty({ enum: [...ORDER_BRAND_DOCUMENT_TYPES] }) type!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ description: 'YYYY-MM-DD' }) date!: string;
}

export class ConsignorViewDto {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
}

export class ConsignmentEwayViewDto {
  @ApiProperty({ enum: [...CONSIGNMENT_EWAY_STATUSES] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) number!: string | null;
  @ApiProperty({ type: String, nullable: true }) date!: string | null;
  @ApiProperty({ type: String, nullable: true }) validUntil!: string | null;
  @ApiProperty({ enum: [...EWAY_EXEMPTION_REASONS, null], nullable: true }) exemptionReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) exemptionNote!: string | null;
}

/** A17 — one version (staff). */
export class ConsignmentViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ description: '1–99' }) seq!: number;
  @ApiProperty({ enum: [...CONSIGNMENT_RECORD_STATUSES] }) status!: string;
  @ApiProperty({ type: ConsignmentDocumentViewDto }) brandDocument!: ConsignmentDocumentViewDto;
  @ApiProperty() consignorGstin!: string;
  @ApiProperty({ type: ConsignorViewDto, description: 'The brand as frozen when recorded' }) consignor!: ConsignorViewDto;
  @ApiProperty() declaredValuePaise!: number;
  @ApiProperty({ type: String, nullable: true, description: 'The ship-to state code; null when unknown' }) destinationStateCode!: string | null;
  @ApiProperty({ enum: ['intra', 'inter', null], nullable: true }) supplyType!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The threshold in force on the document date (null: no bill required)' }) thresholdPaise!: number | null;
  @ApiProperty({ description: 'national | state:NN' }) thresholdRule!: string;
  @ApiProperty() ewayRequired!: boolean;
  @ApiProperty({ type: ConsignmentEwayViewDto }) eway!: ConsignmentEwayViewDto;
  @ApiProperty() recordedAfterDispatch!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Set on the version the goods left under (immutable)' }) dispatchedAt!: string | null;
  @ApiProperty({ enum: [...CONSIGNMENT_RECORD_SOURCES] }) source!: string;
  @ApiProperty({ format: 'uuid' }) recordedBy!: string;
  @ApiProperty() recordedAt!: string;
  @ApiProperty({ type: String, nullable: true }) endedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) endedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) endReason!: string | null;
  @ApiProperty({ required: false, description: "A40 — the declared value is below the order's own rated value (a warning)" }) declaredBelowRatedValue?: boolean;
}

/** A18 — one version (portal: no staff ids). */
export class PortalConsignmentViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() seq!: number;
  @ApiProperty({ enum: [...CONSIGNMENT_RECORD_STATUSES] }) status!: string;
  @ApiProperty({ type: ConsignmentDocumentViewDto }) brandDocument!: ConsignmentDocumentViewDto;
  @ApiProperty() consignorGstin!: string;
  @ApiProperty({ type: ConsignorViewDto }) consignor!: ConsignorViewDto;
  @ApiProperty() declaredValuePaise!: number;
  @ApiProperty({ type: String, nullable: true }) destinationStateCode!: string | null;
  @ApiProperty({ enum: ['intra', 'inter', null], nullable: true }) supplyType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) thresholdPaise!: number | null;
  @ApiProperty() thresholdRule!: string;
  @ApiProperty() ewayRequired!: boolean;
  @ApiProperty({ type: ConsignmentEwayViewDto }) eway!: ConsignmentEwayViewDto;
  @ApiProperty() recordedAfterDispatch!: boolean;
  @ApiProperty({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiProperty({ enum: [...CONSIGNMENT_RECORD_SOURCES] }) source!: string;
  @ApiProperty() recordedByYou!: boolean;
  @ApiProperty() recordedAt!: string;
  @ApiProperty({ type: String, nullable: true }) endedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) endReason!: string | null;
}

export class ConsignmentGateDto {
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_STATES] }) state!: string;
  @ApiProperty() blocking!: boolean;
  @ApiProperty({ enum: [...CONSIGNMENT_REQUIRED_BECAUSE, null], nullable: true }) requiredBecause!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: "max(the order's rated value, its COD amount) — null when it carries neither" }) valueFloorPaise!: number | null;
  @ApiProperty() nationalThresholdPaise!: number;
  @ApiProperty() expiresToday!: boolean;
}

export class ConsignmentRecordResponse {
  @ApiProperty({ type: ConsignmentViewDto }) consignment!: ConsignmentViewDto;
  @ApiProperty({ required: false, enum: [true], description: 'Present (true) on the 200 no-op: the body equals the live version — nothing written, the key stored' }) unchanged?: boolean;
}

export class PortalConsignmentRecordResponse {
  @ApiProperty({ type: PortalConsignmentViewDto }) consignment!: PortalConsignmentViewDto;
  @ApiProperty({ required: false, enum: [true], description: 'Present (true) on the 200 no-op: the body equals the live version — nothing written, the key stored' }) unchanged?: boolean;
}

export class ConsignmentWithdrawResponse {
  @ApiProperty({ type: Object, nullable: true, description: 'Always null' }) consignment!: null;
  @ApiProperty({ type: [ConsignmentViewDto], description: 'Every version, newest first' }) history!: ConsignmentViewDto[];
}

export class ConsignmentOrderRefDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
}

export class ConsignmentOtherClientDto {
  @ApiProperty() clientCode!: string;
  @ApiProperty() orderLabel!: string;
}

export class ConsignmentScanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() purpose!: string;
  @ApiProperty({ type: String, nullable: true }) docKind!: string | null;
  @ApiProperty() fileName!: string;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) byteSize!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pageCount!: number | null;
  @ApiProperty() source!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) uploadedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) urlExpiresAt!: string | null;
}

/** A16 — `GET …/outbound/orders/{orderId}/consignment`. */
export class OrderConsignmentResponse {
  @ApiProperty({ type: ConsignmentGateDto, description: 'The gate judged today (IST)' }) gate!: ConsignmentGateDto;
  @ApiProperty({ type: ConsignmentViewDto, nullable: true }) live!: ConsignmentViewDto | null;
  @ApiProperty({ type: [ConsignmentViewDto], description: 'Superseded and withdrawn versions, newest first' }) history!: ConsignmentViewDto[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The version the goods left under' }) dispatchedRecordId!: string | null;
  @ApiProperty({ type: [ConsignmentOrderRefDto], description: 'Other live records of the client with the same document (a warning)' }) duplicates!: ConsignmentOrderRefDto[];
  @ApiProperty({ description: "The consignor's state differs from the warehouse GSTIN's (a warning; false when the warehouse's state is unknown)" }) consignorStateMismatch!: boolean;
  @ApiProperty({ type: ConsignmentOtherClientDto, nullable: true, description: 'The same e-way number is live under another client (staff only)' }) ewayUsedByOtherClient!: ConsignmentOtherClientDto | null;
  @ApiProperty({ type: [ConsignmentScanDto], description: "4-4a's shipping documents of kinds invoice, challan and eway-bill" }) scans!: ConsignmentScanDto[];
  @ApiProperty({ type: String, nullable: true, description: 'A device handover that left without the documents' }) complianceException!: string | null;
}

/** A18 — `GET …/portal/orders/{orderId}/consignment`. */
export class PortalOrderConsignmentResponse {
  @ApiProperty({ type: ConsignmentGateDto }) gate!: ConsignmentGateDto;
  @ApiProperty({ type: PortalConsignmentViewDto, nullable: true }) live!: PortalConsignmentViewDto | null;
  @ApiProperty({ type: [PortalConsignmentViewDto] }) history!: PortalConsignmentViewDto[];
}

export class ConsignmentWorklistEwayDto {
  @ApiProperty({ type: String, nullable: true }) number!: string | null;
  @ApiProperty({ type: String, nullable: true }) validUntil!: string | null;
}

export class ConsignmentWorklistRowDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() clientCode!: string;
  @ApiProperty({ enum: ['b2b', 'b2c', null], nullable: true }) orderType!: string | null;
  @ApiProperty({ enum: ['accepted', 'packed'] }) stage!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_STATES] }) state!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_REQUIRED_BECAUSE, null], nullable: true }) requiredBecause!: string | null;
  @ApiProperty({ type: Number, nullable: true }) valueFloorPaise!: number | null;
  @ApiProperty({ type: ConsignmentWorklistEwayDto, nullable: true }) eway!: ConsignmentWorklistEwayDto | null;
  @ApiProperty() declaredBelowRatedValue!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) packedAt!: string | null;
}

export class ConsignmentExceptionFreightDto {
  @ApiProperty({ format: 'uuid' }) consignmentId!: string;
  @ApiProperty({ format: 'uuid' }) loadId!: string;
  @ApiProperty() loadCode!: string;
  @ApiProperty() dispatchedAt!: string;
}

export class ConsignmentExceptionRowDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() clientCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The flagged handover shipment; null on a truck consignment’s row (4-9a)' }) shipmentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) handoverId!: string | null;
  @ApiProperty({ type: String, nullable: true }) handoverCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) handedOverAt!: string | null;
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_CODES] }) code!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_STATES], description: 'Re-judged on the handover day' }) state!: string;
  @ApiProperty({ required: false, type: () => ConsignmentExceptionFreightDto, description: 'Story 4-9a (A20) — a truck consignment that left without the documents; absent on a handover row' })
  freight?: ConsignmentExceptionFreightDto;
}

export class ConsignmentWorklistQueryDto {
  @ApiProperty({ required: false, format: 'uuid', description: "One client's orders (the shell's client switcher)" })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiProperty({ required: false, enum: ['needed', 'exceptions'], description: 'needed (default): open orders waiting for documents; exceptions: device handovers that left without them' })
  @IsOptional()
  @IsIn(['needed', 'exceptions'])
  view?: 'needed' | 'exceptions';
}

/** A16 — `GET …/warehouses/{w}/outbound/consignments`. */
export class ConsignmentWorklistResponse {
  @ApiProperty({ enum: ['needed', 'exceptions'] }) view!: string;
  @ApiProperty({ type: [ConsignmentWorklistRowDto], description: 'Packed orders first; at most 5,000 scanned' }) needed!: ConsignmentWorklistRowDto[];
  @ApiProperty({ type: [ConsignmentExceptionRowDto], description: 'At most 500' }) exceptions!: ConsignmentExceptionRowDto[];
  @ApiProperty() truncated!: boolean;
}

export class PortalConsignmentNeededRowDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ type: String, nullable: true }) clientOrderRef!: string | null;
  @ApiProperty({ enum: ['accepted', 'packed'] }) stage!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_STATES] }) state!: string;
  @ApiProperty({ enum: [...CONSIGNMENT_REQUIRED_BECAUSE, null], nullable: true }) requiredBecause!: string | null;
  @ApiProperty({ type: String, nullable: true }) ewayValidUntil!: string | null;
}

/** A18 — `GET …/portal/consignments/needed`. */
export class PortalConsignmentsNeededResponse {
  @ApiProperty({ type: [PortalConsignmentNeededRowDto], description: 'At most 500, packed first' }) items!: PortalConsignmentNeededRowDto[];
}

/** A16 — the 4-4a candidates' and device parcels' consignment key. */
export class ParcelConsignmentDto {
  @ApiProperty({ enum: [...CONSIGNMENT_GATE_STATES] }) state!: string;
  @ApiProperty() blocking!: boolean;
  @ApiProperty({ type: String, nullable: true }) ewayBillNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) ewayValidUntil!: string | null;
}
