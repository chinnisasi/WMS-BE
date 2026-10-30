import { Transform, Type } from 'class-transformer';
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
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import {
  MAX_RMA_EXTERNAL_REFERENCE,
  MAX_RMA_LINES,
  MAX_RMA_NOTE,
  MAX_RMA_SERIALS_PER_LINE,
  AUTHORIZABLE_REASON_CODES,
  BLIND_MATCH_KINDS,
  BLIND_REJECT_REASONS,
  RETURN_REASON_CODES,
  RMA_ORIGINS,
  RMA_REVIEW_STATUSES,
  RMA_STATUSES,
  type AuthorizableReasonCode,
  type BlindMatchKind,
  type BlindRejectReason,
  type ReturnReasonCode,
  type RmaOrigin,
  type RmaReviewStatus,
  type RmaStatus,
} from './return-authorization.command';
import { BLIND_ENTRY_REFUSALS, MAX_BLIND_REVIEW_NOTE, MAX_PARCEL_REFERENCE, type BlindEntryRefusal } from './blind-return.command';
import {
  MAX_RETURN_NOTE,
  MAX_RETURN_RECEIPT_ENTRIES,
  RETURN_CONDITIONS,
  RETURN_ENTRY_REFUSALS,
  type ReturnCondition,
  type ReturnEntryRefusal,
} from './return-receipt.command';
import { MAX_HANDLING_UNIT_WEIGHT_GRAMS } from '../catalog/handling-unit';
import {
  MAX_DISPOSITION_NOTE,
  MAX_RESTOCK_SERIALS,
  RETURN_DISPOSITION_OUTCOMES,
  RETURN_DISPOSITION_REASONS,
  type ReturnDispositionOutcome,
  type ReturnDispositionReason,
} from './return-disposition.command';
import { PORTAL_DISPOSITION_STATES, type PortalDispositionState } from './disposition-reads';

/*
 * Story 13-1 — the returns surface's DTOs. The body DTOs type the request;
 * the request-SHAPE rules the spec names (distinct order lines, `other` needs
 * a note, serial counts, the 500-serial request cap, trimming) are the
 * command's, above its transaction (`normalizeCreate`) — one statement of
 * each rule, every refusal a 400 `validation-failed` naming its line.
 * Quantities are JSON numbers in base units (the ASN and order convention);
 * strings are measured in code points by the command, so the length bounds
 * here are twice the code-point bound (the `AsnNoteDto` precedent).
 */

// ── requests ─────────────────────────────────────────────────────────────────

/**
 * Lowercases a uuid at the validation boundary: the command hashes, lock-keys
 * and matches ids as text, so `ABC…` and `abc…` must be one id (the command
 * lowercases again, defensively).
 */
function LowercaseUuid() {
  return Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value));
}

export class ReturnAuthorizationLineInputDto {
  @ApiProperty({ format: 'uuid', description: 'The order line being returned — a line of the order, never a kit parent' })
  @LowercaseUuid()
  @IsUUID()
  orderLineId!: string;

  @ApiProperty({
    description: `Units authorized for return. ${QUANTITY_FIELD_DESCRIPTION} At most what is still returnable (dispatched minus what uncancelled authorizations already name).`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  // Story 4-7b (A5) — the authorizable codes only (`unannounced` is the blind receipt's).
  @ApiProperty({ enum: [...AUTHORIZABLE_REASON_CODES], description: 'Why the units come back; `other` requires a reasonNote' })
  @IsIn([...AUTHORIZABLE_REASON_CODES])
  reasonCode!: AuthorizableReasonCode;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: `A note on the reason — required for "other"; trimmed, blank means absent, at most ${MAX_RMA_NOTE} characters`,
    maxLength: MAX_RMA_NOTE * 2,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_RMA_NOTE * 2)
  reasonNote?: string | null;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: MAX_RMA_SERIALS_PER_LINE,
    description:
      'Serial-tracked SKUs only, and then required: the serial number of every unit returned (count = qty), each dispatched on this line and not on an uncancelled authorization. At most 500 per line and 500 per request',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RMA_SERIALS_PER_LINE)
  @IsString({ each: true })
  @Length(0, 200, { each: true })
  serialNumbers?: string[];
}

/** POST /tenants/{tenantId}/returns body. */
export class CreateReturnAuthorizationDto {
  @ApiProperty({ format: 'uuid', description: 'The dispatched order being returned' })
  @LowercaseUuid()
  @IsUUID()
  orderId!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: `A channel's or customer's RMA number — trimmed, blank means absent, 1–${MAX_RMA_EXTERNAL_REFERENCE} characters; deliberately not unique`,
    maxLength: MAX_RMA_EXTERNAL_REFERENCE * 2,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_RMA_EXTERNAL_REFERENCE * 2)
  externalReference?: string | null;

  @ApiProperty({
    type: [ReturnAuthorizationLineInputDto],
    minItems: 1,
    maxItems: MAX_RMA_LINES,
    description: 'One entry per order line returned (distinct orderLineIds)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RMA_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReturnAuthorizationLineInputDto)
  lines!: ReturnAuthorizationLineInputDto[];
}

/** POST /tenants/{tenantId}/returns/{rmaId}/cancel body. */
export class CancelReturnAuthorizationDto {
  @ApiProperty({ description: `Why — required, 1–${MAX_RMA_NOTE} characters after trimming`, minLength: 1, maxLength: MAX_RMA_NOTE * 2 })
  @IsString()
  @Length(1, MAX_RMA_NOTE * 2)
  reason!: string;
}

/** GET /tenants/{tenantId}/returns/returnable query. */
export class ReturnableQuery {
  @ApiProperty({ format: 'uuid', description: 'The order whose returnable quantities to read' })
  @LowercaseUuid()
  @IsUUID()
  orderId!: string;
}

/** GET /tenants/{tenantId}/returns query. */
export class ReturnAuthorizationListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's return authorizations. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: "Only one warehouse's authorizations (tenant-wide when absent)" })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: [...RMA_STATUSES], description: 'Only authorizations of one status' })
  @IsOptional()
  @IsIn([...RMA_STATUSES])
  status?: RmaStatus;

  @ApiProperty({ required: false, format: 'uuid', description: "Only one order's authorizations" })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  orderId?: string;

  @ApiProperty({ required: false, enum: [...RMA_ORIGINS], description: 'Story 4-7b — only authorized, or only blind (unannounced), return authorizations' })
  @IsOptional()
  @IsIn([...RMA_ORIGINS])
  origin?: RmaOrigin;

  @ApiProperty({ required: false, enum: [...RMA_REVIEW_STATUSES], description: 'Story 4-7b — only unannounced returns in one review state (the Unannounced tab reads pending)' })
  @IsOptional()
  @IsIn([...RMA_REVIEW_STATUSES])
  reviewStatus?: RmaReviewStatus;

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

// ── responses ────────────────────────────────────────────────────────────────

export class ReturnSerialDto {
  @ApiProperty({ format: 'uuid', description: "The catalog serial id (the ledger's serialRef)" })
  id!: string;

  @ApiProperty({ description: 'The serial number people and scanners speak' })
  serialNumber!: string;
}

export class ReturnAuthorizationLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The order line returned — story 4-7b: null on an unannounced line no accept has linked' })
  orderLineId!: string | null;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Units authorized for return, in base UoM' })
  authorizedQty!: number;

  @ApiProperty({ description: 'Units received against this line so far, in base UoM (story 13-2 records receipts; 0 until then)', minimum: 0 })
  receivedQty!: number;

  @ApiProperty({ enum: [...RETURN_REASON_CODES] })
  reasonCode!: ReturnReasonCode;

  @ApiProperty({ type: String, nullable: true, description: 'The reason note; null when none was given' })
  reasonNote!: string | null;

  @ApiProperty({ type: [ReturnSerialDto], description: 'Serial-tracked lines: the authorized serials, sorted by number; empty otherwise' })
  serials!: readonly ReturnSerialDto[];
}

/** One return authorization — the detail, a list item, and both commands' response. */
export class ReturnAuthorizationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The server-allocated code, `RMA-0001`, unique per tenant' })
  code!: string;

  @ApiProperty({ enum: [...RMA_STATUSES] })
  status!: RmaStatus;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The order returned — story 4-7b: null on an unannounced return not linked to an order' })
  orderId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The order's reference at authorization — story 4-1b: its client order number, else its channel reference (external event id); null when it has neither. An RMA created before 4-1b holds the channel reference only" })
  orderReference!: string | null;

  @ApiProperty({ format: 'uuid', description: "The order's warehouse — where the return will be received" })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: "The order's client" })
  clientId!: string;

  @ApiProperty({ type: String, nullable: true, description: "A channel's or customer's RMA number; null when none was given" })
  externalReference!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When the order was dispatched (ISO-8601 UTC) — recorded at authorization; story 4-7b: null exactly when orderId is' })
  orderDispatchedAt!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time (the keyset field)' })
  createdAt!: string;

  @ApiProperty({ format: 'uuid', description: 'Who authorized it' })
  createdBy!: string;

  @ApiProperty({ type: String, nullable: true, description: 'When it was cancelled (ISO-8601 UTC); null unless cancelled' })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Who cancelled it; null unless cancelled' })
  cancelledBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Why it was cancelled; null unless cancelled' })
  cancelReason!: string | null;

  @ApiProperty({ type: [ReturnAuthorizationLineDto], description: 'The authorized lines, in the order they were named' })
  lines!: readonly ReturnAuthorizationLineDto[];

  @ApiProperty({
    required: false,
    type: () => [ReturnReceiptViewDto],
    description:
      'Story 13-2 — the receipts against this authorization, oldest first. Present ONLY on GET /returns/{rmaId}; absent on the list and on the create/cancel responses',
  })
  receipts?: readonly ReturnReceiptViewDto[];

  @ApiProperty({ required: false, enum: [...RMA_ORIGINS], description: 'Story 4-7b — authorized (13-1) or blind (an unannounced parcel). Always present on the list and detail reads; absent on a pre-4-7b create/cancel response' })
  origin?: RmaOrigin;

  @ApiProperty({ required: false, type: String, nullable: true, enum: [...RMA_REVIEW_STATUSES, null], description: "Story 4-7b — a blind return's review; null on an authorized one" })
  reviewStatus?: RmaReviewStatus | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Story 4-7b — the scanned AWB or order number of a blind return' })
  parcelReference?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'Story 4-7b — the dispatched order the parcel reference matched (a suggestion only)' })
  suggestedOrderId?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, enum: [...BLIND_MATCH_KINDS, null], description: 'Story 4-7b — how the reference matched: the carrier AWB or the order reference' })
  matchKind?: BlindMatchKind | null;

  @ApiProperty({ required: false, type: Boolean, nullable: true, description: 'Story 4-7b — the operator chose the client at a barcode several clients share; null on an authorized return' })
  clientPrompted?: boolean | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Story 4-7b — when the review was decided (ISO-8601 UTC)' })
  reviewedAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'Story 4-7b — who decided the review' })
  reviewedBy?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, enum: [...BLIND_REJECT_REASONS, null], description: 'Story 4-7b — why a blind return was rejected' })
  reviewReasonCode?: BlindRejectReason | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: "Story 4-7b — the reject's note" })
  reviewNote?: string | null;

  @ApiProperty({
    required: false,
    type: () => [RmaRefDto],
    description: "Story 4-7b — detail only: the suggested order's open or partially received return authorizations (the card's flag)",
  })
  openRmasForSuggestedOrder?: readonly RmaRefDto[];

  @ApiProperty({
    required: false,
    type: () => [SameParcelRmaDto],
    description: 'Story 4-7b — detail only: other unannounced returns received with the same parcel reference, any review state',
  })
  sameParcelRmas?: readonly SameParcelRmaDto[];
}

/** Story 4-7b — another RMA named on a blind return's card. */
export class RmaRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...RMA_STATUSES] })
  status!: RmaStatus;
}

/** Story 4-7b (A20) — another blind RMA with the same parcel reference. */
export class SameParcelRmaDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...RMA_REVIEW_STATUSES] })
  reviewStatus!: RmaReviewStatus;
}

export class ReturnAuthorizationListResponse {
  @ApiProperty({ type: [ReturnAuthorizationDto] })
  items!: readonly ReturnAuthorizationDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class ReturnableLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: "A kit component's parent line; null for a top-level line" })
  parentLineId!: string | null;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'A kit parent (a line with component lines) — never returnable itself; return its components' })
  kitParent!: boolean;

  @ApiProperty({ description: 'Units dispatched on this line, in base UoM (0 for an order not dispatched)' })
  dispatchedQty!: number;

  @ApiProperty({ description: 'Units already on uncancelled authorizations (open, partially received or received), in base UoM' })
  authorizedQty!: number;

  @ApiProperty({ description: 'max(0, dispatched − authorized), in base UoM' })
  returnableQty!: number;

  @ApiProperty({ description: 'Whether the SKU is serial-tracked (then a return names its serial numbers)' })
  serialTracked!: boolean;

  @ApiProperty({ type: [ReturnSerialDto], description: 'Serial-tracked lines: the dispatched serials not on an uncancelled authorization, sorted by number' })
  returnableSerials!: readonly ReturnSerialDto[];
}

export class ReturnableOrderDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ description: "The order's status — only `dispatched` is returnable; any other answers zero everywhere" })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: String, nullable: true, description: "Story 4-1b — the order's client order number, else its channel reference; null when it has neither" })
  orderReference!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When the order was dispatched (ISO-8601 UTC); null when it is not' })
  dispatchedAt!: string | null;

  @ApiProperty({ type: [ReturnableLineDto], description: "The order's lines, in order-line order" })
  lines!: readonly ReturnableLineDto[];
}

// ── story 13-2: the return receipt ──────────────────────────────────────────

/** One scanned unit, case or run of untracked units of a `return.receive` op. */
export class ReturnReceiptEntryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The authorization line it is received against — null for a unit that is on no line (it is refused not-on-authorization and sent to review)',
  })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  rmaLineId!: string | null;

  @ApiProperty({ format: 'uuid' })
  @LowercaseUuid()
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Units received, base UoM. ${QUANTITY_FIELD_DESCRIPTION} A serial entry is exactly 1 unit; a catch-weight entry is exactly 1 case.`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ enum: [...RETURN_CONDITIONS], description: "The inspection grade (human decision 1) — it suggests a disposition; it decides nothing" })
  @IsIn([...RETURN_CONDITIONS])
  condition!: ReturnCondition;

  @ApiProperty({ required: false, type: String, nullable: true, description: `An inspection note — trimmed, blank means absent, at most ${MAX_RETURN_NOTE} characters`, maxLength: MAX_RETURN_NOTE * 2 })
  @IsOptional()
  @IsString()
  @Length(0, MAX_RETURN_NOTE * 2)
  note?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: "Batch-tracked SKUs: the unit's batch — one the order line was picked from", maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(0, 128)
  batchCode?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Serial-tracked SKUs: the unit\'s serial number — one the line authorizes (qty 1)', maxLength: 400 })
  @IsOptional()
  @IsString()
  @Length(0, 400)
  serialNumber?: string | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    description: `Catch-weight SKUs: the case's weight in whole grams (qty 1), at most ${MAX_HANDLING_UNIT_WEIGHT_GRAMS}`,
    minimum: 1,
    maximum: MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_HANDLING_UNIT_WEIGHT_GRAMS)
  weightGrams?: number | null;
}

/** POST /tenants/{tenantId}/returns/receipts body — the `return.receive` op. */
export class ReceiveReturnDto {
  @ApiProperty({ format: 'uuid', description: "The warehouse receiving — must be the authorization's (409 document-warehouse-mismatch otherwise)" })
  @LowercaseUuid()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The return authorization received against (open or partially received)' })
  @LowercaseUuid()
  @IsUUID()
  rmaId!: string;

  @ApiProperty({ description: "Device time (ISO-8601 UTC, Z-suffixed) — the ledger events' business time" })
  @IsString()
  occurredAt!: string;

  @ApiProperty({
    type: [ReturnReceiptEntryDto],
    minItems: 1,
    maxItems: MAX_RETURN_RECEIPT_ENTRIES,
    description: `1–${MAX_RETURN_RECEIPT_ENTRIES} entries, one per unit or case (an untracked run may carry several units) — the device splits a larger receipt into several ops`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_RECEIPT_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => ReturnReceiptEntryDto)
  entries!: ReturnReceiptEntryDto[];
}

export class ReturnEntryAppliedDto {
  @ApiProperty({ description: "The entry's place in the op (0-based)" })
  entryIndex!: number;

  @ApiProperty({ format: 'uuid' })
  rmaLineId!: string;

  @ApiProperty({ description: 'Units booked into RETURNS, base UoM' })
  qty!: number;
}

export class ReturnEntryRefusedDto {
  @ApiProperty({ description: "The entry's place in the op (0-based)" })
  entryIndex!: number;

  @ApiProperty({ enum: [...RETURN_ENTRY_REFUSALS], description: 'Why it was not booked — the entry is in the review queue' })
  reason!: ReturnEntryRefusal;
}

/** The `return.receive` 201 — and its idempotency snapshot. */
export class ReturnReceiptResultDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The receipt; null when every entry was refused' })
  returnReceiptId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'RRN-0001; null when every entry was refused' })
  code!: string | null;

  @ApiProperty({ enum: [...RMA_STATUSES], description: "The authorization's status after this receipt (unchanged when nothing applied)" })
  rmaStatus!: RmaStatus;

  @ApiProperty({ type: [ReturnEntryAppliedDto] })
  applied!: readonly ReturnEntryAppliedDto[];

  @ApiProperty({ type: [ReturnEntryRefusedDto], description: 'The refused entries — all of them sit in ONE review-queue row (Discard only)' })
  refused!: readonly ReturnEntryRefusedDto[];

  @ApiProperty({ type: String, nullable: true, description: "The review row's op id when entries were refused (derived from the key, never equal to it); null otherwise" })
  reviewOpId!: string | null;
}

export class ReturnReceiptLineViewDto {
  @ApiProperty({ format: 'uuid', description: "Story 4-7a — the receipt line's id (a disposition's address)" })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  rmaLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Units received, base UoM' })
  qty!: number;

  @ApiProperty({ enum: [...RETURN_CONDITIONS] })
  condition!: ReturnCondition;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serialNumber!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "A returned case's captured weight, grams" })
  weightGrams!: number | null;

  @ApiProperty({ minimum: 0, description: 'Story 4-7a — units still awaiting a disposition, base UoM' })
  openQty!: number;

  @ApiProperty({ minimum: 0, description: 'Story 4-7a — units restocked to a storage bin, base UoM' })
  restockedQty!: number;

  @ApiProperty({ minimum: 0, description: 'Story 4-7a — units scrapped, base UoM' })
  scrappedQty!: number;

  @ApiProperty({ minimum: 0, description: 'Story 4-7a — units on an open return QC hold, base UoM' })
  onHoldQty!: number;

  @ApiProperty({ minimum: 0, description: 'Story 4-7a — units that failed a return hold\'s inspection (now in DAMAGED), base UoM' })
  failedInspectionQty!: number;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 4-7b — an unannounced return\'s line: units awaiting review (qty while pending, else 0); absent on an authorized return' })
  pendingReviewQty?: number;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 4-7b — an unannounced return\'s line: units reversed at review (qty once rejected, else 0); absent on an authorized return' })
  reversedQty?: number;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 4-7c — units on a draft or picked return to client, base UoM; present (with returnedToClientQty) only when either is above 0' })
  returningToClientQty?: number;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 4-7c — units shipped back to the client, base UoM; present (with returningToClientQty) only when either is above 0' })
  returnedToClientQty?: number;
}

export class ReturnReceiptViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'RRN-0001' })
  code!: string;

  @ApiProperty({ description: 'Device time of the receipt (ISO-8601 UTC)' })
  occurredAt!: string;

  @ApiProperty({ type: String, nullable: true, description: "The receiving operator's email (null when the user no longer exists)" })
  operatorEmail!: string | null;

  @ApiProperty({ type: [ReturnReceiptLineViewDto] })
  lines!: readonly ReturnReceiptLineViewDto[];
}

// ── story 4-7a: returns disposition ─────────────────────────────────────────

/** POST /tenants/{tenantId}/returns/dispositions body — the web's disposition of one receipt line. */
export class DisposeReturnDto {
  @ApiProperty({ format: 'uuid', description: "The warehouse — must be the receipt's (409 document-warehouse-mismatch otherwise)" })
  @LowercaseUuid()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The return-receipt line dispositioned (the detail read\'s receipts[].lines[].id)' })
  @LowercaseUuid()
  @IsUUID()
  receiptLineId!: string;

  @ApiProperty({ enum: [...RETURN_DISPOSITION_OUTCOMES], description: 'restock (to a storage bin), quarantine (a QC hold) or scrap' })
  @IsIn([...RETURN_DISPOSITION_OUTCOMES])
  outcome!: ReturnDispositionOutcome;

  @ApiProperty({
    description: `Units dispositioned, base UoM — at most what the line still awaits. ${QUANTITY_FIELD_DESCRIPTION} A serial unit or a returned case is exactly 1.`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'Restock only — the storage bin the units go to' })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  toBinId?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, enum: [...RETURN_DISPOSITION_REASONS, null], description: 'Quarantine and scrap only (required there)' })
  @IsOptional()
  @IsIn([...RETURN_DISPOSITION_REASONS])
  reasonCode?: ReturnDispositionReason | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: `Quarantine and scrap only — trimmed, blank means absent, at most ${MAX_DISPOSITION_NOTE} characters; required with the reason "other"`,
    maxLength: MAX_DISPOSITION_NOTE * 2,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_DISPOSITION_NOTE * 2)
  note?: string | null;
}

/** POST /tenants/{tenantId}/returns/restocks body — the handheld's `return.restock` op. */
export class RestockReturnDto {
  @ApiProperty({ format: 'uuid' })
  @LowercaseUuid()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU restocked — the server allocates it to the oldest sellable awaiting lines' })
  @LowercaseUuid()
  @IsUUID()
  skuId!: string;

  @ApiProperty({ description: `Units restocked, base UoM. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001, maximum: MAX_QUANTITY_BASE })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Batch-tracked (non-serial) SKUs: the batch restocked (required — 400 batch-required)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(0, 128)
  batchCode?: string | null;

  @ApiProperty({
    required: false,
    type: [String],
    nullable: true,
    description: `Serial-tracked SKUs: one serial number per unit (qty = count), at most ${MAX_RESTOCK_SERIALS}`,
    maxItems: MAX_RESTOCK_SERIALS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESTOCK_SERIALS)
  @IsString({ each: true })
  @Length(0, 400, { each: true })
  serialNumbers?: string[] | null;

  @ApiProperty({ format: 'uuid', description: 'The storage bin scanned' })
  @LowercaseUuid()
  @IsUUID()
  toBinId!: string;

  @ApiProperty({ description: "Device time (ISO-8601 UTC, Z-suffixed) — the ledger event's business time" })
  @IsString()
  occurredAt!: string;
}

export class ReturnDispositionEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  receiptLineId!: string;

  @ApiProperty({ format: 'uuid' })
  rmaId!: string;

  @ApiProperty({ enum: [...RETURN_DISPOSITION_OUTCOMES] })
  outcome!: ReturnDispositionOutcome;

  @ApiProperty({ description: 'Units, base UoM' })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Restock: the storage bin' })
  toBinId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Quarantine: the QC hold (kind return)' })
  qcHoldId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Restock / scrap: the ledger event' })
  ledgerEventId!: string | null;
}

/** The 201 of both disposition routes — and their idempotency snapshot. */
export class ReturnDispositionResultDto {
  @ApiProperty({ type: [ReturnDispositionEntryDto] })
  dispositions!: readonly ReturnDispositionEntryDto[];
}

/** GET /tenants/{tenantId}/returns/awaiting query. */
export class AwaitingDispositionQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Only one warehouse's lines (tenant-wide when absent)" })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: "Only one client's lines. An unknown id is an empty page" })
  @IsOptional()
  @LowercaseUuid()
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

export class AwaitingDispositionDto {
  @ApiProperty({ format: 'uuid' })
  receiptLineId!: string;

  @ApiProperty({ description: 'RRN-0001' })
  receiptCode!: string;

  @ApiProperty({ description: 'When the unit was received (device time, ISO-8601 UTC)' })
  receivedAt!: string;

  @ApiProperty({ format: 'uuid' })
  rmaId!: string;

  @ApiProperty({ description: 'RMA-0001' })
  rmaCode!: string;

  @ApiProperty({ type: String, nullable: true })
  orderReference!: string | null;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'The base unit of measure' })
  uom!: string;

  @ApiProperty({ enum: [...RETURN_CONDITIONS], description: 'The grade the unit was received with' })
  condition!: ReturnCondition;

  @ApiProperty({ type: String, nullable: true, description: 'The inspection note at receipt' })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serialNumber!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "A returned case's weight, grams" })
  weightGrams!: number | null;

  @ApiProperty({ description: 'Units received on the line, base UoM' })
  receivedQty!: number;

  @ApiProperty({ description: 'Units still awaiting a disposition, base UoM' })
  openQty!: number;

  @ApiProperty({ description: 'Units on an open return QC hold, base UoM' })
  onHoldQty!: number;

  @ApiProperty({ description: 'How many times the line was quarantined before' })
  priorQuarantines!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The latest quarantine or scrap reason on the line' })
  lastReasonCode!: string | null;
}

export class AwaitingDispositionListResponse {
  @ApiProperty({ type: [AwaitingDispositionDto] })
  items!: readonly AwaitingDispositionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

// ── story 4-7a: the client portal's returns ─────────────────────────────────

/** GET /tenants/{tenantId}/portal/returns query. */
export class PortalReturnsQuery {
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

  @ApiProperty({
    required: false,
    enum: [...PORTAL_DISPOSITION_STATES],
    description: '`awaiting` — units still open or on an unsettled hold; `dispositioned` — every received unit decided',
  })
  @IsOptional()
  @IsIn([...PORTAL_DISPOSITION_STATES])
  dispositionState?: PortalDispositionState;
}

export class PortalReturnRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'RMA-0001' })
  code!: string;

  @ApiProperty({ enum: [...RMA_STATUSES] })
  status!: RmaStatus;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Story 4-7b — null on an accepted unannounced return linked to no order' })
  orderId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  orderReference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalReference!: string | null;

  @ApiProperty({ enum: [...RMA_ORIGINS], description: 'Story 4-7b — authorized, or blind (an unannounced parcel — listed once accepted)' })
  origin!: RmaOrigin;

  @ApiProperty({ type: String, nullable: true, description: "Story 4-7b — an unannounced return's scanned AWB or order number" })
  parcelReference!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Base units (summed across lines)' })
  receivedTotal!: number;

  @ApiProperty()
  restockedTotal!: number;

  @ApiProperty()
  onHoldTotal!: number;

  @ApiProperty()
  failedInspectionTotal!: number;

  @ApiProperty()
  scrappedTotal!: number;

  @ApiProperty()
  openTotal!: number;

  @ApiProperty({ description: 'Story 4-7c — units on a return to the client being prepared (base units)' })
  returningToClientTotal!: number;

  @ApiProperty({ description: 'Story 4-7c — units shipped back to the client (base units)' })
  returnedToClientTotal!: number;
}

export class PortalReturnPageResponse {
  @ApiProperty({ type: [PortalReturnRowDto] })
  items!: readonly PortalReturnRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalReturnLineDto {
  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty()
  authorizedQty!: number;

  @ApiProperty()
  receivedQty!: number;

  @ApiProperty({ enum: [...RETURN_REASON_CODES], description: 'Why the customer returned it' })
  returnReasonCode!: ReturnReasonCode;

  @ApiProperty()
  restockedQty!: number;

  @ApiProperty()
  onHoldQty!: number;

  @ApiProperty()
  failedInspectionQty!: number;

  @ApiProperty()
  scrappedQty!: number;

  @ApiProperty()
  openQty!: number;

  @ApiProperty({ description: 'Story 4-7c — on a return to the client being prepared' })
  returningToClientQty!: number;

  @ApiProperty({ description: 'Story 4-7c — shipped back to the client' })
  returnedToClientQty!: number;
}

export class PortalReturnDispositionDto {
  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ enum: [...RETURN_DISPOSITION_OUTCOMES] })
  outcome!: ReturnDispositionOutcome;

  @ApiProperty()
  qty!: number;

  @ApiProperty({ type: String, nullable: true, enum: [...RETURN_DISPOSITION_REASONS, null], description: 'Quarantine and scrap reasons; null on a restock' })
  reasonCode!: ReturnDispositionReason | null;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  occurredAt!: string;
}

export class PortalReturnDetailResponse extends PortalReturnRowDto {
  @ApiProperty({ type: [PortalReturnLineDto] })
  lines!: readonly PortalReturnLineDto[];

  @ApiProperty({ type: [PortalReturnDispositionDto], description: 'Oldest first' })
  dispositions!: readonly PortalReturnDispositionDto[];
}

// ── story 4-7b: blind returns ───────────────────────────────────────────────

/** One scanned unit, case or run of untracked units of an unannounced parcel. */
export class BlindReceiptEntryDto {
  @ApiProperty({ format: 'uuid', description: "The SKU scanned — the parcel's client's (sku-not-of-client otherwise)" })
  @LowercaseUuid()
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Units received, base UoM. ${QUANTITY_FIELD_DESCRIPTION} A serial entry is exactly 1 unit; a catch-weight entry is exactly 1 case.`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ enum: [...RETURN_CONDITIONS], description: 'The inspection grade (13-2)' })
  @IsIn([...RETURN_CONDITIONS])
  condition!: ReturnCondition;

  @ApiProperty({ required: false, type: String, nullable: true, description: `An inspection note — trimmed, blank means absent, at most ${MAX_RETURN_NOTE} characters`, maxLength: MAX_RETURN_NOTE * 2 })
  @IsOptional()
  @IsString()
  @Length(0, MAX_RETURN_NOTE * 2)
  note?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: "Batch-tracked SKUs: an existing batch of the SKU (never created)", maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(0, 128)
  batchCode?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Serial-tracked SKUs: an existing serial of the SKU, out of stock (qty 1)', maxLength: 400 })
  @IsOptional()
  @IsString()
  @Length(0, 400)
  serialNumber?: string | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    description: `Catch-weight SKUs: the case's weight in whole grams (qty 1), at most ${MAX_HANDLING_UNIT_WEIGHT_GRAMS}`,
    minimum: 1,
    maximum: MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_HANDLING_UNIT_WEIGHT_GRAMS)
  weightGrams?: number | null;
}

/** POST /tenants/{tenantId}/returns/blind-receipts body — the `return.receive_blind` op. */
export class ReceiveBlindReturnDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse receiving the parcel' })
  @LowercaseUuid()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: "The parcel's client — fixed on the handheld by the first unit's SKU" })
  @LowercaseUuid()
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'The operator chose the client at a barcode several clients share (A24)' })
  @IsBoolean()
  clientPrompted!: boolean;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: `The scanned AWB or order number — trimmed, blank means skipped, at most ${MAX_PARCEL_REFERENCE} characters`,
    maxLength: MAX_PARCEL_REFERENCE * 2,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_PARCEL_REFERENCE * 2)
  parcelReference?: string | null;

  @ApiProperty({ description: "Device time (ISO-8601 UTC, Z-suffixed) — the ledger events' business time" })
  @IsString()
  occurredAt!: string;

  @ApiProperty({
    type: [BlindReceiptEntryDto],
    minItems: 1,
    maxItems: MAX_RETURN_RECEIPT_ENTRIES,
    description: `1–${MAX_RETURN_RECEIPT_ENTRIES} entries — one parcel is one op; the device receives the rest as another parcel`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_RECEIPT_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => BlindReceiptEntryDto)
  entries!: BlindReceiptEntryDto[];
}

export class BlindEntryAppliedDto {
  @ApiProperty({ description: "The entry's place in the op (0-based)" })
  entryIndex!: number;

  @ApiProperty({ description: 'Units booked into RETURNS, base UoM' })
  qty!: number;
}

export class BlindEntryRefusedDto {
  @ApiProperty({ description: "The entry's place in the op (0-based)" })
  entryIndex!: number;

  @ApiProperty({ enum: [...BLIND_ENTRY_REFUSALS], description: 'Why it was not booked — the entry is in the review queue (Discard only)' })
  reason!: BlindEntryRefusal;
}

/** The `return.receive_blind` 201 — and its idempotency snapshot. */
export class BlindReceiptResultDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The blind return authorization created; null when every entry was refused' })
  rmaId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'RMA-0001; null when every entry was refused' })
  rmaCode!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The receipt; null when every entry was refused' })
  returnReceiptId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'RRN-0001; null when every entry was refused' })
  code!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The one dispatched order the parcel reference matched; null when none or several did' })
  suggestedOrderId!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...BLIND_MATCH_KINDS, null] })
  matchKind!: BlindMatchKind | null;

  @ApiProperty({ type: [BlindEntryAppliedDto] })
  applied!: readonly BlindEntryAppliedDto[];

  @ApiProperty({ type: [BlindEntryRefusedDto], description: 'The refused entries — all of them sit in ONE review-queue row (Discard only)' })
  refused!: readonly BlindEntryRefusedDto[];

  @ApiProperty({ type: String, nullable: true, description: "The review row's op id when entries were refused (derived from the key); null otherwise" })
  reviewOpId!: string | null;
}

/** POST /tenants/{tenantId}/returns/{rmaId}/accept body. */
export class AcceptBlindReturnDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: "The dispatched order to link — the parcel's client and warehouse; null is the explicit \"No order\"",
  })
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  orderId!: string | null;
}

/** The accept's 200 — the return authorization plus the lines no order line could take. */
export class BlindAcceptResultDto extends ReturnAuthorizationDto {
  @ApiProperty({ type: [String], description: 'The RMA line ids left unlinked (every line under "No order")' })
  unlinkedLines!: readonly string[];
}

/** POST /tenants/{tenantId}/returns/{rmaId}/reject body. */
export class RejectBlindReturnDto {
  @ApiProperty({ enum: [...BLIND_REJECT_REASONS], description: '`other` requires a note' })
  @IsIn([...BLIND_REJECT_REASONS])
  reasonCode!: BlindRejectReason;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: `Required for "other"; trimmed, blank means absent, at most ${MAX_BLIND_REVIEW_NOTE} characters`,
    maxLength: MAX_BLIND_REVIEW_NOTE * 2,
  })
  @IsOptional()
  @IsString()
  @Length(0, MAX_BLIND_REVIEW_NOTE * 2)
  note?: string | null;
}
