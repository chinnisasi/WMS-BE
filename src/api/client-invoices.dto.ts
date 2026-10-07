import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
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
import { LINE_RECORD_KINDS, type LineRecordKind } from '../modules/billing/invoice-records';

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
  @ApiProperty({ format: 'uuid', description: "The line's id — the dispute drill's address (21-5b). A draft's lines are rewritten (new ids) when it is refreshed or answers stale" })
  id!: string;

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

// ── story 21-5b — the dispute drill-down ─────────────────────────────────────

export class OrderRefDto {
  @ApiProperty({ type: String, nullable: true, example: 'manual', description: '`manual` or the channel the order came from; null only when the order row is missing' })
  source!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The channel's event id (the web labels it \"Channel ref\"); null on a manual order — there is no order number yet" })
  externalEventId!: string | null;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;
}

export class ReceiptLineRecordDto {
  @ApiProperty({ enum: ['receipt-line'] }) kind!: 'receipt-line';
  @ApiProperty({ format: 'uuid', description: 'The GRN line' }) id!: string;
  @ApiProperty() grnCode!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The purchase order the GRN booked against — null on a blind receipt' }) poCode!: string | null;
  @ApiProperty({ description: "The GRN's recorded_at (the server stamp), ISO-8601 UTC at full precision" }) recordedAt!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty() skuCode!: string;
  @ApiProperty() skuName!: string;
  @ApiProperty({ example: '12.5', description: 'Received, base units — a decimal string' }) qty!: string;
  @ApiProperty({ description: 'Applied at once (the rest pended as an over-receipt), base units — a decimal string' }) appliedQty!: string;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ type: String, nullable: true, description: "The actor's email; null when the user is unknown" }) actorEmail!: string | null;
}

export class PickRecordDto {
  @ApiProperty({ enum: ['pick'] }) kind!: 'pick';
  @ApiProperty({ format: 'uuid', description: 'The pick row' }) id!: string;
  @ApiProperty({ description: "The pick row's created_at (the server clock), ISO-8601 UTC at full precision" }) pickedAt!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty({ type: OrderRefDto }) orderRef!: OrderRefDto;
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty() skuCode!: string;
  @ApiProperty() skuName!: string;
  @ApiProperty({ description: 'Picked, base units — a decimal string' }) qty!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The bin the operator scanned' }) binCode!: string | null;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ type: String, nullable: true }) actorEmail!: string | null;
}

export class OrderRecordDto {
  @ApiProperty({ enum: ['order'] }) kind!: 'order';
  @ApiProperty({ format: 'uuid', description: "The order's FIRST dispatch event (the one that billed it)" }) id!: string;
  @ApiProperty({ description: "That event's recorded_at, ISO-8601 UTC at full precision" }) dispatchedAt!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty({ type: OrderRefDto }) orderRef!: OrderRefDto;
  @ApiProperty({ description: "The order's dispatch events in this window and group — one per order line shipped" }) lines!: number;
  @ApiProperty({ type: String, nullable: true, description: "The first event's carrier" }) carrierName!: string | null;
  @ApiProperty({ type: String, nullable: true }) trackingNumber!: string | null;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ type: String, nullable: true }) actorEmail!: string | null;
}

export class StorageDayRecordDto {
  @ApiProperty({ enum: ['storage-day'] }) kind!: 'storage-day';
  @ApiProperty({ example: '2026-09-14', description: 'The IST day this is the closing stock of' }) date!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty({ description: 'The base UoM (the line’s)' }) uom!: string;
  @ApiProperty({ example: '300', description: 'On hand at the end of the IST day, base units — a decimal string' }) onHand!: string;
}

export const LINE_RECORD_DTOS = [ReceiptLineRecordDto, PickRecordDto, OrderRecordDto, StorageDayRecordDto] as const;

export type LineRecordDto = ReceiptLineRecordDto | PickRecordDto | OrderRecordDto | StorageDayRecordDto;

export class LineRecordsSummaryDto {
  @ApiProperty({ example: '412', description: "The line's quantity as the line view states it (storage base-unit-days, a whole count otherwise)" })
  lineQuantity!: string;

  @ApiProperty({ example: '412', description: 'The same figure re-derived now from every record of the predicate, in the same units' })
  recordsQuantity!: string;

  @ApiProperty({ description: 'The two are exactly equal' })
  reconciles!: boolean;
}

export class ClientInvoiceLineRecordsResponse {
  @ApiProperty({ enum: [...LINE_RECORD_KINDS], description: 'The kind of every record on this line' })
  kind!: LineRecordKind;

  @ApiProperty({ enum: [...CLIENT_INVOICE_STATUSES], description: 'The invoice status the drill was read under' })
  invoiceStatus!: ClientInvoiceStatus;

  @ApiProperty({ type: LineRecordsSummaryDto, required: false, description: 'The first page only (no cursor)' })
  summary?: LineRecordsSummaryDto;

  @ApiProperty({
    type: 'array',
    items: {
      oneOf: LINE_RECORD_DTOS.map((dto) => ({ $ref: getSchemaPath(dto) })),
      discriminator: {
        propertyName: 'kind',
        mapping: {
          'receipt-line': getSchemaPath(ReceiptLineRecordDto),
          pick: getSchemaPath(PickRecordDto),
          order: getSchemaPath(OrderRecordDto),
          'storage-day': getSchemaPath(StorageDayRecordDto),
        },
      },
    },
  })
  records!: LineRecordDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class StorageBreakdownSkuDto {
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty() skuCode!: string;
  @ApiProperty() skuName!: string;
  @ApiProperty({ example: '120.5', description: 'On hand at the end of the day, signed base units — a negative SKU is kept (it is part of the sum)' }) onHand!: string;
}

export class StorageBreakdownResponse {
  @ApiProperty({ example: '2026-09-14' }) date!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty() uom!: string;
  @ApiProperty({ type: [StorageBreakdownSkuDto], description: 'Every SKU of the base UoM whose on-hand is not zero, by code' }) skus!: StorageBreakdownSkuDto[];
  @ApiProperty({ description: 'Σ of the SKUs, base units' }) total!: string;
  @ApiProperty({ type: String, nullable: true, description: "The day's snapshot, base units — null when the day closed at ≤ 0 (no snapshot is written)" })
  snapshotOnHand!: string | null;
  @ApiProperty({ description: 'total = snapshotOnHand (or total ≤ 0 when there is no snapshot)' }) reconciles!: boolean;
}
