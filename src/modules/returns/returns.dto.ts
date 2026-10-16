import { Transform, Type } from 'class-transformer';
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
  RETURN_REASON_CODES,
  RMA_STATUSES,
  type ReturnReasonCode,
  type RmaStatus,
} from './return-authorization.command';
import {
  MAX_RETURN_NOTE,
  MAX_RETURN_RECEIPT_ENTRIES,
  RETURN_CONDITIONS,
  RETURN_ENTRY_REFUSALS,
  type ReturnCondition,
  type ReturnEntryRefusal,
} from './return-receipt.command';
import { MAX_HANDLING_UNIT_WEIGHT_GRAMS } from '../catalog/handling-unit';

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

  @ApiProperty({ enum: [...RETURN_REASON_CODES], description: 'Why the units come back; `other` requires a reasonNote' })
  @IsIn([...RETURN_REASON_CODES])
  reasonCode!: ReturnReasonCode;

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

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

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

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ type: String, nullable: true, description: "The order's channel reference at authorization (its external event id); null for a manual order" })
  orderReference!: string | null;

  @ApiProperty({ format: 'uuid', description: "The order's warehouse — where the return will be received" })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: "The order's client" })
  clientId!: string;

  @ApiProperty({ type: String, nullable: true, description: "A channel's or customer's RMA number; null when none was given" })
  externalReference!: string | null;

  @ApiProperty({ description: 'When the order was dispatched (ISO-8601 UTC) — recorded at authorization' })
  orderDispatchedAt!: string;

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

  @ApiProperty({ type: String, nullable: true, description: "The order's channel reference; null for a manual order" })
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
