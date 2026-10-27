import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  CHARGE_DESCRIPTION_MAX,
  CHARGE_NOTE_MAX,
  CHARGE_REFERENCE_MAX,
  CLIENT_CHARGE_CATEGORIES,
  CLIENT_CHARGE_LIST_DEFAULT_LIMIT,
  CLIENT_CHARGE_LIST_MAX_LIMIT,
  CLIENT_CHARGE_STATUSES,
  CLIENT_CHARGE_UNITS,
  CLIENT_CHARGE_WARNING_CODES,
  MAX_CHARGE_RATE_PAISE,
  MAX_SELF_APPROVE_LIMIT_PAISE,
  OTHER_SACS,
  type ClientChargeCategory,
  type ClientChargeStatus,
  type ClientChargeUnit,
  type ClientChargeWarningCode,
} from '../modules/billing/client-charges';
import { CLIENT_INVOICE_STATUSES } from '../modules/billing/client-invoices';

/**
 * Story 5-5a — the ad-hoc charge DTOs. Shape only (types): the service owns
 * every rule — the vocabularies, the code-point lengths, the quantity
 * format, the rate and amount ranges, the SAC rule — above the transaction,
 * and the date window behind the replay lookup.
 */

export class RecordClientChargeDto {
  @ApiProperty({ format: 'uuid', description: 'The client brand billed (never the tenant’s own client — 409 client-not-billable)' })
  @IsString()
  clientId!: string;

  @ApiProperty({ format: 'uuid', description: 'The warehouse the work was done in — it decides the supplying GSTIN (the invoice group)' })
  @IsString()
  warehouseId!: string;

  @ApiProperty({
    example: '2026-10-05',
    description: 'The IST date of the work: today or earlier, back to 1 April of the previous financial year (400 outside). More than 30 days back answers 201 with `charge-late`',
  })
  @IsString()
  chargeDate!: string;

  @ApiProperty({ enum: [...CLIENT_CHARGE_CATEGORIES], description: 'Each category fixes its SAC; `other` chooses one (sacCode)' })
  @IsString()
  category!: string;

  @ApiProperty({ maxLength: CHARGE_DESCRIPTION_MAX, description: 'What was done — 1–200 characters, printed on the invoice line' })
  @IsString()
  description!: string;

  @ApiProperty({ required: false, enum: [...OTHER_SACS], description: 'REQUIRED for `other` (one of the four services SACs); refused on any other category' })
  @IsOptional()
  @IsString()
  sacCode?: string;

  @ApiProperty({ enum: [...CLIENT_CHARGE_UNITS] })
  @IsString()
  unit!: string;

  @ApiProperty({ example: '2.5', description: 'A decimal string, > 0, at most three decimal places, ≤ 10,000 ("2.5" and "2.50" are the same request)' })
  @IsString()
  quantity!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_CHARGE_RATE_PAISE, example: 35000, description: 'Integer paise per unit, GST-exclusive (₹0.01 .. ₹1 lakh). The amount is quantity × rate rounded half up once; ₹0.00 is refused, the cap is ₹1 crore' })
  @IsInt()
  unitRatePaise!: number;

  @ApiProperty({ required: false, maxLength: CHARGE_REFERENCE_MAX, description: 'An order ref, GRN or ASN code — free text, printed (" · Ref …")' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty({
    required: false,
    maxLength: CHARGE_REFERENCE_MAX,
    description: "The client's authorisation for the work — a PO, email or work-order reference; printed (\" · Client auth …\") and shown in the drill",
  })
  @IsOptional()
  @IsString()
  clientAuthorizationRef?: string;

  @ApiProperty({ required: false, maxLength: CHARGE_NOTE_MAX, description: 'Internal only — never printed, never shown in the portal' })
  @IsOptional()
  @IsString()
  evidenceNote?: string;
}

export class ChargeNoteDto {
  @ApiProperty({ maxLength: CHARGE_NOTE_MAX, description: 'Why — required, 1–500 characters' })
  @IsString()
  note!: string;
}

export class ChargePolicyDto {
  @ApiProperty({
    minimum: 0,
    maximum: MAX_SELF_APPROVE_LIMIT_PAISE,
    example: 1000000,
    description: 'A billing.invoice holder’s own charge up to this amount (integer paise, ₹0 .. ₹1 crore) is approved at record; above it, it pends for a second person',
  })
  @IsInt()
  selfApproveLimitPaise!: number;
}

export class ClientChargeListQuery {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: [...CLIENT_CHARGE_STATUSES] })
  @IsOptional()
  @IsIn([...CLIENT_CHARGE_STATUSES])
  status?: ClientChargeStatus;

  @ApiProperty({ required: false, example: '2026-10', description: 'The billing month (YYYY-MM) — the invoice month that bills the charge' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be a calendar month YYYY-MM' })
  month?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: CLIENT_CHARGE_LIST_MAX_LIMIT, default: CLIENT_CHARGE_LIST_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLIENT_CHARGE_LIST_MAX_LIMIT)
  limit?: number;
}

export class ClientChargeBillingDto {
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The invoice number; null while it is a draft' }) invoiceNo!: string | null;
  @ApiProperty({ enum: CLIENT_INVOICE_STATUSES.filter((status) => status !== 'void') }) status!: string;
}

export class ClientChargeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The supplying GSTIN frozen at record — the invoice group key' }) supplierGstin!: string | null;
  @ApiProperty({ example: '2026-10-05', description: 'The IST date of the work' }) chargeDate!: string;
  @ApiProperty({ example: '2026-10-01', description: 'The first of the month whose invoice bills it — later than the service month when that month was already invoiced' }) billMonth!: string;
  @ApiProperty({ enum: [...CLIENT_CHARGE_CATEGORIES] }) category!: ClientChargeCategory;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '996719' }) sacCode!: string;
  @ApiProperty({ enum: [...CLIENT_CHARGE_UNITS] }) unit!: ClientChargeUnit;
  @ApiProperty({ example: '2.5', description: 'Units of `unit`, a decimal string (up to three places)' }) quantity!: string;
  @ApiProperty() unitRatePaise!: number;
  @ApiProperty({ description: 'quantity × rate, rounded half up once — integer paise, GST-exclusive' }) amountPaise!: number;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ type: String, nullable: true }) clientAuthorizationRef!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Internal only' }) evidenceNote!: string | null;
  @ApiProperty({ enum: [...CLIENT_CHARGE_STATUSES] }) status!: ClientChargeStatus;
  @ApiProperty({ format: 'uuid' }) recordedBy!: string;
  @ApiProperty({ description: 'ISO-8601 UTC' }) recordedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Who approved or rejected it (the recorder when approved at record)' }) decidedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) decidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A rejection’s reason' }) decisionNote!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) cancelledBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelledAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelNote!: string | null;
  @ApiProperty({ description: 'ISO-8601 UTC' }) createdAt!: string;
  @ApiProperty({ type: ClientChargeBillingDto, nullable: true, description: 'The latest non-void invoice with a line billing this charge, or null' })
  billing!: ClientChargeBillingDto | null;
}

export class ClientChargeWarningDto {
  @ApiProperty({ enum: [...CLIENT_CHARGE_WARNING_CODES] }) code!: ClientChargeWarningCode;
  @ApiProperty() detail!: string;
}

export class RecordClientChargeResponse {
  @ApiProperty({ type: ClientChargeDto }) charge!: ClientChargeDto;
  @ApiProperty({ type: [ClientChargeWarningDto], description: 'Non-blocking: charge-late, charge-billed-later, charge-may-bring-minimum, charge-disables-minimum' })
  warnings!: ClientChargeWarningDto[];
}

export class ClientChargeResponse {
  @ApiProperty({ type: ClientChargeDto }) charge!: ClientChargeDto;
}

export class ClientChargeListResponse {
  @ApiProperty({ type: [ClientChargeDto] }) items!: ClientChargeDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ChargePolicyResponse {
  @ApiProperty({ description: 'Integer paise' }) selfApproveLimitPaise!: number;
  @ApiProperty({ description: 'No setting stored — the ₹10,000 default applies' }) isDefault!: boolean;
}
