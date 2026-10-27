import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import {
  NOTE_KINDS,
  NOTE_LINES_MAX,
  NOTE_REASONS,
  NOTE_REGISTER_MAX_LIMIT,
  NOTE_STATUSES,
  NOTE_TEXT_MAX,
  type NoteKind,
  type NoteReason,
  type NoteStatus,
} from '../modules/billing/client-invoice-notes';
import { SUPPLY_TYPES } from '../modules/billing/client-invoices';
import { CHARGE_CODES, RATE_BASES, type ChargeCode, type RateBasis } from '../modules/billing/rate-cards';
import { ClientInvoiceDto, ClientInvoicePartyDto, ClientInvoiceTotalsDto } from './client-invoices.dto';

/**
 * Story 5-6a — the credit / debit note DTOs. Shape only (types): the service
 * owns every rule — the vocabularies, the code-point lengths, the line count
 * and the eligibility, the caps, the deadlines — above the transaction or
 * behind the replay lookup as the house skeleton places them.
 */

export class NoteLineRequestDto {
  @ApiProperty({ format: 'uuid', description: 'A line of the invoice the note amends (one note line per invoice line)' })
  @IsString()
  invoiceLineId!: string;

  @ApiProperty({ description: 'The taxable delta, positive integer paise (the kind gives the sign)', minimum: 1 })
  @IsInt()
  amountPaise!: number;

  @ApiProperty({
    required: false,
    maxLength: NOTE_TEXT_MAX,
    description: 'A DEBIT line above its invoice line’s taxable value needs a reason (409 debit-needs-override without one); refused on a credit',
  })
  @IsOptional()
  @IsString()
  overrideReason?: string;
}

export class CreateNoteDto {
  @ApiProperty({ enum: [...NOTE_KINDS] })
  @IsString()
  kind!: string;

  @ApiProperty({
    enum: [...NOTE_REASONS],
    description: 'credit: deficiency-in-service | post-supply-discount | excess-billed; debit: short-billed',
  })
  @IsString()
  reason!: string;

  @ApiProperty({ maxLength: NOTE_TEXT_MAX, description: 'Why — 1–500 characters. Printed on the note the client receives' })
  @IsString()
  reasonNote!: string;

  @ApiProperty({
    required: false,
    description: 'A credit note that settles the invoice’s dispute when issued (the invoice must be disputed). Never on a debit',
  })
  @IsOptional()
  @IsBoolean()
  settlesDispute?: boolean;

  @ApiProperty({ type: [NoteLineRequestDto], minItems: 1, maxItems: NOTE_LINES_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(NOTE_LINES_MAX)
  @ValidateNested({ each: true })
  @Type(() => NoteLineRequestDto)
  lines!: NoteLineRequestDto[];
}

export class VoidNoteDto {
  @ApiProperty({ maxLength: NOTE_TEXT_MAX, description: 'Why the note is voided — required, 1–500 characters' })
  @IsString()
  voidNote!: string;
}

export class NotePolicyDto {
  @ApiProperty({ description: 'Whether a credit note needs a second person to issue it (and another to void it). A tenant with no setting requires one' })
  @IsBoolean()
  requireSecondApprover!: boolean;
}

export class NoteLineDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) invoiceLineId!: string;
  @ApiProperty({ enum: [...CHARGE_CODES] }) chargeCode!: ChargeCode;
  @ApiProperty({ enum: [...RATE_BASES] }) basis!: RateBasis;
  @ApiProperty({ type: String, nullable: true }) uom!: string | null;
  @ApiProperty({ example: '2026-09-01', description: 'IST date, inclusive (the invoice line’s segment)' }) segmentFrom!: string;
  @ApiProperty({ example: '2026-09-30', description: 'IST date, inclusive' }) segmentTo!: string;
  @ApiProperty({ example: '996729' }) sac!: string;
  @ApiProperty({ example: 1800 }) gstBps!: number;
  @ApiProperty() placeOfSupply!: string;
  @ApiProperty({ enum: [...SUPPLY_TYPES] }) supplyType!: 'intra' | 'inter';
  @ApiProperty({ description: 'Taxable value, positive integer paise' }) amountPaise!: number;
  @ApiProperty() cgstPaise!: number;
  @ApiProperty({ description: 'SGST/UTGST' }) sgstPaise!: number;
  @ApiProperty() igstPaise!: number;
  @ApiProperty({ type: String, nullable: true }) overrideReason!: string | null;
}

export class NoteEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ enum: [...NOTE_KINDS] }) kind!: NoteKind;
  @ApiProperty({ enum: [...NOTE_STATUSES] }) status!: NoteStatus;
  @ApiProperty({ enum: [...NOTE_REASONS] }) reason!: NoteReason;
  @ApiProperty() reasonNote!: string;
  @ApiProperty() settlesDispute!: boolean;
  @ApiProperty({ type: String, nullable: true, example: '29/C2627/000001' }) noteNo!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'FY-2627' }) fyLabel!: string | null;
  @ApiProperty() supplierGstin!: string;
  @ApiProperty() placeOfSupply!: string;
  @ApiProperty({ enum: [...SUPPLY_TYPES] }) supplyType!: 'intra' | 'inter';
  @ApiProperty({ type: ClientInvoiceTotalsDto, description: 'Positive magnitudes, integer paise; a credit subtracts, a debit adds' })
  totals!: ClientInvoiceTotalsDto;
  @ApiProperty({ type: String, nullable: true }) issuedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) issuedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidNote!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) voidedBy!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty() createdAt!: string;
}

export class NoteDto extends NoteEntryDto {
  @ApiProperty({ type: String, nullable: true }) invoiceNo!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' }) invoiceIssuedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2027-11-30', description: 'A credit’s last IST day to issue (CGST Act s.34(2)); null for a debit' })
  creditDeadline!: string | null;
  @ApiProperty({ type: ClientInvoicePartyDto, description: 'The invoice’s frozen party, copied verbatim' }) party!: ClientInvoicePartyDto;
  @ApiProperty({ type: [NoteLineDto] }) lines!: NoteLineDto[];
}

export class NoteResponse {
  @ApiProperty({ type: NoteDto }) note!: NoteDto;
}

export class IssueNoteResponse {
  @ApiProperty({ type: NoteDto }) note!: NoteDto;
  @ApiProperty({ type: ClientInvoiceDto, required: false, description: 'The invoice, present when the note settled its dispute' })
  invoice?: ClientInvoiceDto;
}

export class InvoiceNotesResponse {
  @ApiProperty({ type: [NoteEntryDto] }) notes!: NoteEntryDto[];
  @ApiProperty({ type: ClientInvoiceTotalsDto, description: 'The invoice after its ISSUED notes (− credits, + debits). The document value, not an outstanding balance' })
  netDocument!: ClientInvoiceTotalsDto;
  @ApiProperty({ description: '`netDocument.payable`' }) netDocumentPayable!: number;
}

export class NotePolicyResponse {
  @ApiProperty() requireSecondApprover!: boolean;
}

export class NoteRegisterQuery {
  @ApiProperty({ required: false, description: 'The supplying GSTIN — required' })
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiProperty({ required: false, example: '2027-05-01', description: 'First IST date (inclusive) — required' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiProperty({ required: false, example: '2027-05-31', description: 'Last IST date (inclusive) — required; at most 366 days' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiProperty({ required: false, enum: [...NOTE_KINDS] })
  @IsOptional()
  @IsIn([...NOTE_KINDS])
  kind?: NoteKind;

  @ApiProperty({ required: false, enum: ['issued', 'void'] })
  @IsOptional()
  @IsIn(['issued', 'void'])
  status?: 'issued' | 'void';

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: NOTE_REGISTER_MAX_LIMIT, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTE_REGISTER_MAX_LIMIT)
  limit?: number;
}

export class NoteRegisterRowDto {
  @ApiProperty({ format: 'uuid' }) noteId!: string;
  @ApiProperty({ example: '29/C2627/000001' }) noteNo!: string;
  @ApiProperty({ example: '2027-05-20', description: 'The note’s IST date' }) noteDate!: string;
  @ApiProperty({ enum: [...NOTE_KINDS] }) kind!: NoteKind;
  @ApiProperty({ enum: ['issued', 'void'] }) status!: 'issued' | 'void';
  @ApiProperty() voided!: boolean;
  @ApiProperty({ type: String, nullable: true }) recipientGstin!: string | null;
  @ApiProperty() recipientName!: string;
  @ApiProperty() placeOfSupply!: string;
  @ApiProperty({ enum: [...SUPPLY_TYPES] }) supplyType!: 'intra' | 'inter';
  @ApiProperty() invoiceNo!: string;
  @ApiProperty({ description: 'The original invoice’s IST date' }) invoiceDate!: string;
  @ApiProperty() gstBps!: number;
  @ApiProperty() taxablePaise!: number;
  @ApiProperty() igstPaise!: number;
  @ApiProperty() cgstPaise!: number;
  @ApiProperty() sgstPaise!: number;
  @ApiProperty({ description: 'The whole note’s payable value (repeated on each of its rate rows)' }) noteValuePaise!: number;
}

export class NoteRegisterResponse {
  @ApiProperty({ type: [NoteRegisterRowDto], description: 'One row per (note, GST rate), oldest first' }) rows!: NoteRegisterRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
