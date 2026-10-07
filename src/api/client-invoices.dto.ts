import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, ValidateBy } from 'class-validator';
import {
  CLIENT_INVOICE_GAP_CODES,
  CLIENT_INVOICE_STATUSES,
  CLIENT_INVOICE_WARNING_CODES,
  STATUS_NOTE_MAX,
  SUPPLY_TYPES,
  type ClientInvoiceGapCode,
  type ClientInvoiceStatus,
  type ClientInvoiceWarningCode,
} from '../modules/billing/client-invoices';
import { CHARGE_CODES, RATE_BASES, type ChargeCode, type RateBasis } from '../modules/billing/rate-cards';

/**
 * Story 21-5 — the client-invoice DTOs. Shape only: the command owns every
 * rule (the month having ended, the gaps, the transitions), behind the replay
 * lookup. Paise are integer numbers; quantities decimal strings.
 */

const Trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * A length ceiling in CODE POINTS (`[...value].length`) — what the service,
 * the 0062 CHECK (`char_length`) and the web count. `@MaxLength` counts UTF-16
 * units and would refuse a 500-character note of astral characters.
 */
const MaxCodePoints = (max: number) =>
  ValidateBy({
    name: 'maxCodePoints',
    constraints: [max],
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || [...value].length <= max,
      defaultMessage: () => `note must be at most ${max} characters`,
    },
  });

export class PrepareClientInvoicesDto {
  @ApiProperty({ example: '2026-09', description: 'One IST calendar month, YYYY-MM — it must have ended' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be a calendar month YYYY-MM' })
  month!: string;
}

export class ClientInvoiceNoteDto {
  @ApiProperty({
    required: false,
    maxLength: STATUS_NOTE_MAX,
    description: 'Why — REQUIRED to dispute or void (400 without one), optional to settle. The invoice keeps the latest note; the audit trail keeps every one',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxCodePoints(STATUS_NOTE_MAX)
  note?: string;
}

export class ClientInvoiceGapDto {
  @ApiProperty({ enum: [...CLIENT_INVOICE_GAP_CODES] })
  code!: ClientInvoiceGapCode;

  @ApiProperty()
  detail!: string;

  @ApiProperty({ required: false, format: 'uuid' })
  warehouseId?: string;

  @ApiProperty({ required: false, description: 'The IST date the line’s rate-card segment starts (line-scoped gaps)' })
  segmentFrom?: string;
}

export class ClientInvoiceWarningDto {
  @ApiProperty({ enum: [...CLIENT_INVOICE_WARNING_CODES] })
  code!: ClientInvoiceWarningCode;

  @ApiProperty()
  detail!: string;
}

export class ClientInvoiceSupplierAddressDto {
  @ApiProperty() line1!: string;
  @ApiProperty({ type: String, nullable: true }) line2!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty({ description: 'The origin address state, as entered' }) state!: string;
  @ApiProperty() pincode!: string;
}

export class ClientInvoiceSupplierDto {
  @ApiProperty({ description: "The tenant's name" }) name!: string;
  @ApiProperty({ type: String, nullable: true }) gstin!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "The GSTIN's two-digit state code" }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateName!: string | null;
  @ApiProperty({ type: ClientInvoiceSupplierAddressDto, nullable: true }) address!: ClientInvoiceSupplierAddressDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'The warehouse whose origin address is printed' }) warehouseCode!: string | null;
}

export class ClientInvoiceRecipientAddressDto {
  @ApiProperty({ type: String, nullable: true }) line1!: string | null;
  @ApiProperty({ type: String, nullable: true }) line2!: string | null;
  @ApiProperty({ type: String, nullable: true }) city!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) pincode!: string | null;
}

export class ClientInvoiceRecipientDto {
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) gstin!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateName!: string | null;
  @ApiProperty({ type: ClientInvoiceRecipientAddressDto }) address!: ClientInvoiceRecipientAddressDto;
}

export class ClientInvoicePartyDto {
  @ApiProperty({ type: ClientInvoiceSupplierDto }) supplier!: ClientInvoiceSupplierDto;
  @ApiProperty({ type: ClientInvoiceRecipientDto }) recipient!: ClientInvoiceRecipientDto;
}

export class ClientInvoiceTotalsDto {
  @ApiProperty({ description: 'Taxable value, integer paise' }) subtotal!: number;
  @ApiProperty() cgst!: number;
  @ApiProperty() sgst!: number;
  @ApiProperty() igst!: number;
  @ApiProperty({ description: 'cgst + sgst + igst' }) tax!: number;
  @ApiProperty({ description: 'Signed rupee round-off, −49…+50 paise' }) roundOff!: number;
  @ApiProperty({ description: 'subtotal + tax + roundOff — a whole number of rupees, in paise' }) payable!: number;
}

export class ClientInvoiceLineDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The rate card that priced the line (null: no card in force)' })
  rateCardId!: string | null;

  @ApiProperty({ example: '2026-09-01', description: 'First IST date of the rate-card segment (inclusive)' })
  segmentFrom!: string;

  @ApiProperty({ example: '2026-09-30', description: 'Last IST date of the segment (inclusive)' })
  segmentTo!: string;

  @ApiProperty({ enum: [...CHARGE_CODES] })
  chargeCode!: ChargeCode;

  @ApiProperty({ enum: [...RATE_BASES] })
  basis!: RateBasis;

  @ApiProperty({ type: String, nullable: true, description: 'The base UoM of a storage line; null for handling' })
  uom!: string | null;

  @ApiProperty({ example: '1234.567', description: 'A decimal string: base-unit-days for storage (up to three decimals), a whole count otherwise' })
  quantity!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Integer paise per unit of the basis (null: unpriced, a draft only)' })
  unitAmountPaise!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'The taxable value, integer paise (null: unpriced, a draft only)' })
  amountPaise!: number | null;

  @ApiProperty({ example: '996729', description: 'The SAC (services accounting code)' })
  sac!: string;

  @ApiProperty({ example: 1800 })
  gstBps!: number;

  @ApiProperty({ type: String, nullable: true, description: 'Two-digit state code of the place of supply' })
  placeOfSupply!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...SUPPLY_TYPES, null] })
  supplyType!: 'intra' | 'inter' | null;

  @ApiProperty() cgstPaise!: number;
  @ApiProperty({ description: 'SGST/UTGST' }) sgstPaise!: number;
  @ApiProperty() igstPaise!: number;
}

class ClientInvoiceCommonDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ example: '2026-09-01' }) periodStart!: string;
  @ApiProperty({ example: '2026-09-30' }) periodEnd!: string;
  @ApiProperty({ enum: [...CLIENT_INVOICE_STATUSES] }) status!: ClientInvoiceStatus;
  @ApiProperty({ type: String, nullable: true, example: '29/S2627/000001' }) invoiceNo!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'FY-2627' }) fyLabel!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The supplying GSTIN (the group key)' }) supplierGstin!: string | null;
  @ApiProperty({ type: String, nullable: true }) placeOfSupply!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...SUPPLY_TYPES, null] }) supplyType!: 'intra' | 'inter' | null;
  @ApiProperty({ type: ClientInvoiceTotalsDto }) totals!: ClientInvoiceTotalsDto;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' }) issuedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The latest dispute / settle / void note' }) statusNote!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The void invoice this one replaces' }) replacesInvoiceId!: string | null;
  @ApiProperty({ description: 'ISO-8601 UTC' }) createdAt!: string;
}

export class ClientInvoiceEntryDto extends ClientInvoiceCommonDto {
  @ApiProperty({ description: 'How many gaps block issue (0 on every issued invoice)' })
  gapCount!: number;
}

export class ClientInvoiceDto extends ClientInvoiceCommonDto {
  @ApiProperty({ type: [ClientInvoiceGapDto] }) gaps!: ClientInvoiceGapDto[];
  @ApiProperty({ type: [ClientInvoiceWarningDto] }) warnings!: ClientInvoiceWarningDto[];
  @ApiProperty({ type: ClientInvoicePartyDto, description: 'Supplier and recipient as printed — computed live on a draft, frozen at issue' })
  party!: ClientInvoicePartyDto;
  @ApiProperty({ type: [ClientInvoiceLineDto] }) lines!: ClientInvoiceLineDto[];
}

export class ClientInvoiceResponse {
  @ApiProperty({ type: ClientInvoiceDto }) invoice!: ClientInvoiceDto;
}

export class IssueClientInvoiceResponse {
  @ApiProperty({
    enum: ['issued', 'stale'],
    description: "`stale`: the figures changed since the draft was last computed — the fresh draft is stored and returned, nothing is issued and no number is used. Review it and issue again (with a NEW Idempotency-Key)",
  })
  outcome!: 'issued' | 'stale';

  @ApiProperty({ type: ClientInvoiceDto }) invoice!: ClientInvoiceDto;
}

export class PrepareClientInvoicesResponse {
  @ApiProperty({ type: [ClientInvoiceDto], description: 'The drafts created — one per supplying GSTIN with usage and no live invoice' })
  created!: ClientInvoiceDto[];

  @ApiProperty({ type: [ClientInvoiceDto], description: 'The live (not void) invoices that already cover a group' })
  existing!: ClientInvoiceDto[];
}

export class ClientInvoiceListResponse {
  @ApiProperty({ type: [ClientInvoiceEntryDto] }) items!: ClientInvoiceEntryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
