import { Type } from 'class-transformer';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_DECIMALS,
  QUANTITY_FIELD_DESCRIPTION,
  } from '../../shared/primitives/quantity';
import { STORAGE_CLASSES } from '../../shared/primitives/storage-class';
import { DG_CLASSES, DG_PACKING_GROUPS } from '../../shared/primitives/goods-type';
import { LICENCE_HOLDERS, LICENCE_NEEDS, type LicenceHolder, type LicenceNeed } from '../../shared/primitives/licence';
import { UOMS } from '../catalog/uom';
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
  Matches,
  Max,
  Min,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BooleanFlag, IsInstant } from '../../shared/primitives/instant-range';
import { PurchaseOrderLineDto } from './inbound.dto';
import {
  MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  MAX_HANDLING_UNITS_PER_REQUEST,
} from '../catalog/handling-unit';
import { MAX_HANDLING_UNITS_PER_GRN_LINE, REJECTED_GRN_LINE_CODES, UNMATCHED_LINE_REASONS } from './receiving.command';
// Story 3.5 (additive): the snapshot's putaway decision fields reuse the
// putaway module's DTOs (one shape on every surface).
import { PutawayBinDto, PutawayTaskDto } from '../putaway/putaway.dto';
import { PickTaskDto } from '../outbound/outbound.dto';

/** The fixed blind-receive reason enum (the I/O matrix). */
export const BLIND_REASON_ENUM = ['unannounced-delivery', 'po-not-found', 'other'] as const;

// ── grn.submit input ─────────────────────────────────────────────────────────

/** One received (sku, batch) line as the device submits it. */
export class GrnLineInputDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'The PO line received against — null on a blind receipt\'s lines',
  })
  @IsOptional()
  @IsUUID()
  poLineId?: string | null;

  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description:
      "Story 21-6 — the ASN line received against (only beside asnId). A line with no line reference, or whose SKU differs from the referenced line's, settles unmatched: applied in full, crediting no line",
  })
  @IsOptional()
  @IsUUID()
  asnLineId?: string | null;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'Catalog batch code (required for batch-tracked SKUs, forbidden otherwise)',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/\S/, { message: 'batchCode must contain non-whitespace characters' })
  batchCode?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'Optional batch mfg date (ISO-8601 UTC, Z-suffixed)',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  mfgDate?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: '2027-03-31',
    description:
      "Story 1-2b — the batch's expiry date as the label states it: an IST calendar date YYYY-MM-DD (a malformed one is a 400). Omit when there is none. Every rule about it is a per-line refusal: on an untracked SKU (`expiry-on-untracked`), before the line's mfg date (`expiry-before-mfg`), unlike the batch's existing expiry or another line's for the same batch (`batch-expiry-mismatch`), missing when the client requires it (`expiry-required`), or fewer days away than the client's minimum (`shelf-life-short`, its own review row)",
  })
  @IsOptional()
  @IsString()
  @Length(10, 10)
  expiryDate?: string | null;

  @ApiProperty({
    description: `Physically received quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({
    required: false,
    type: [Number],
    nullable: true,
    maxItems: MAX_HANDLING_UNITS_PER_GRN_LINE,
    // (the command additionally caps the REQUEST at
    // MAX_HANDLING_UNITS_PER_REQUEST across every line)
    description:
      'Catch weight (story 10.3): one captured weight in whole GRAMS per physical unit on this line — required for a catch-weight-tracked SKU, refused for every other SKU, and exactly qty entries long. It is a per-unit actual weight, never a quantity and never the parcel weight pack records.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(Math.min(MAX_HANDLING_UNITS_PER_GRN_LINE, MAX_HANDLING_UNITS_PER_REQUEST))
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_HANDLING_UNIT_WEIGHT_GRAMS, { each: true })
  weightsGrams?: number[] | null;
}

/** POST /tenants/{tenantId}/receiving/goods-receipts body (device session). */
export class SubmitGoodsReceiptDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the receipt lands in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'The purchase order received against — exactly one of poId, asnId and blindReasonCode',
  })
  @IsOptional()
  @IsUUID()
  poId?: string | null;

  @ApiProperty({
    required: false,
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'Story 21-6 — the advance shipment notice received against — exactly one of poId, asnId and blindReasonCode',
  })
  @IsOptional()
  @IsUUID()
  asnId?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: [...BLIND_REASON_ENUM, null],
    description: 'The blind-receive reason code (required when neither poId nor asnId is given, forbidden otherwise)',
  })
  @IsOptional()
  @IsIn(BLIND_REASON_ENUM as unknown as string[])
  blindReasonCode?: string | null;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Story 1-1 — the client a BLIND receipt is for (named only beside blindReasonCode; a PO or ASN receipt takes its document\'s client, and naming one there is a 400). Absent (an older build): the client is derived from the first line\'s SKU. A line whose SKU belongs to another client is refused per line (`sku-client-mismatch` in rejectedLines) and the rest settles. An unknown client is a 404',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ description: 'Device time of the receipt (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    type: [GrnLineInputDto],
    minItems: 1,
    maxItems: 200,
    description: 'The physically received lines',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => GrnLineInputDto)
  lines!: GrnLineInputDto[];
}

// ── grn responses ────────────────────────────────────────────────────────────

/** One GRN line as every surface returns it. */
export class GrnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true, description: 'The PO line credited — null on a blind, ASN or unmatched line. Story 21-9: on a late receipt (a closed PO) the line the excess pends against, null when it matched none' })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN line credited; present only when one was. Story 21-9: on a late receipt (a cancelled or closed ASN) the line the excess pends against, when it matched one' })
  asnLineId?: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  // The schema floor matches the receipt validator (@Min(0.001)): physical
  // truth is fractional since story 10-1, so a sub-1 line quantity is real.
  @ApiProperty({ description: 'Physical truth: everything that arrived', minimum: 0.001 })
  qty!: number;

  @ApiProperty({ description: 'The within-open portion applied immediately — 0 on every line of a late receipt (story 21-9)', minimum: 0 })
  appliedQty!: number;

  @ApiProperty({ description: 'The excess pended for approval — the whole quantity on a late receipt against a closed or cancelled document (story 21-9)', minimum: 0 })
  excessQty!: number;

  @ApiProperty({
    required: false,
    minimum: 0,
    description:
      "Story 1-2b — the part of appliedQty past the open quantity that booked at once within the client's receiving tolerance (no over-receipt). Present only when > 0",
  })
  toleranceQty?: number;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Catch weight (story 10.3): the handling units this line produced, in the order their weights were supplied — present only on a catch-weight line. These ids are what a unit label carries and what the pack bench scans back.',
  })
  handlingUnitIds?: readonly string[];
}

/** Story 1-6d — one need of a `licence-not-covered` line that no valid licence covers. */
export class MissingLicenceDto {
  @ApiProperty({ enum: [...LICENCE_NEEDS], description: 'What the goods need: drug-20b (G/H/H1), drug-21b (C/C1), drug-20g (X), ndps, or fssai (food)' })
  need!: LicenceNeed;

  @ApiProperty({ enum: [...LICENCE_HOLDERS], description: '`client` — the brand holds no valid licence for this site (or for none); `site` — the site holds no valid licence' })
  holder!: LicenceHolder;
}

/** One line the server refused to settle (naming the reason — the others settle). */
export class RejectedGrnLineDto {
  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'The PO line named — null on an ASN line rejection' })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN line named; present only on an ASN line rejection' })
  asnLineId?: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ minimum: 0.001 })
  qty!: number;

  @ApiProperty({
    enum: [...REJECTED_GRN_LINE_CODES],
    description:
      'Machine reason. Only an OPEN document rejects a line. `po-line-not-open` is defensive since story 21-9 (an open PO has no cancelled or carried line) and stays in the enum for older clients. Story 1-1: `sku-client-mismatch` — a BLIND receipt\'s line whose SKU belongs to another client than the receipt\'s; it goes to the review queue (Discard only). Story 1-2a: `client-departed` — a line of ANY receipt whose SKU\'s client has departed; also to review (Discard only — re-receive after an owner reactivates the client). Story 1-2b — the expiry rules, each per line: `expiry-on-untracked`, `expiry-before-mfg`, `batch-expiry-mismatch`, `expiry-required` (review, Discard only) and `shelf-life-short` (its own review row — Accept anyway with a note, or Discard). Story 1-6d: `licence-not-covered` — licence enforcement is on and no valid client and site licence covers the line\'s drug or food goods on the receipt\'s IST date; its own review row (`grn.licence-refused` — an owner may accept it anyway with a note, or discard it)',
  })
  code!: string;

  @ApiProperty({ description: 'Human-readable reason naming the line state' })
  reason!: string;

  @ApiProperty({ required: false, type: 'integer', minimum: 0, description: "Story 1-2b — the line's index in the request (present on an expiry refusal and — 1-6d — a licence refusal only)" })
  index?: number;

  @ApiProperty({ required: false, type: String, nullable: true, description: "Story 1-2b — the line's batch code (present on an expiry refusal only)" })
  batchCode?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description:
      "Story 1-2b — the expiry date the rule judged (YYYY-MM-DD, IST): the line's own, or for `expiry-required` / `shelf-life-short` the effective one (the line's, else its batch's); null when none. Present on an expiry refusal only",
  })
  expiryDate?: string | null;

  @ApiProperty({ required: false, type: 'integer', minimum: 0, description: "Story 1-2b — `shelf-life-short` only: the client's minimum remaining shelf life in days (0 when the client sets none — the batch had expired)" })
  minShelfLifeDays?: number;

  @ApiProperty({
    required: false,
    type: [MissingLicenceDto],
    description:
      'Story 1-6d — `licence-not-covered` only: each need no valid licence covers on the receipt\'s IST date, and which holder lacks it (the entry also carries `index`)',
  })
  missing?: readonly MissingLicenceDto[];
}

/** Story 21-6 — one request line that settled unmatched (applied in full, no line credited). */
export class UnmatchedGrnLineDto {
  @ApiProperty({ minimum: 0, description: 'The line\'s index in the request\'s lines array' })
  index!: number;

  @ApiProperty({
    enum: [...UNMATCHED_LINE_REASONS],
    description: 'no-line-reference: the line named no document line; line-sku-mismatch: its SKU is not the referenced line\'s',
  })
  reason!: (typeof UNMATCHED_LINE_REASONS)[number];
}

/** The GRN as the submit response / replay returns it. */
export class GoodsReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Server-assigned code (GRN-<n>, unique per tenant)' })
  code!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true, description: 'The PO booked against. Story 21-9: a receipt against a closed PO with an open carried successor is booked against the successor, named here' })
  poId!: string | null;

  @ApiProperty({ required: false, description: 'Story 21-9 — the successor PO\'s code; present only on a receipt re-targeted from a closed PO to its open successor' })
  poCode?: string;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN received against; present only on an ASN receipt' })
  asnId?: string;

  @ApiProperty({ required: false, description: 'Story 21-6 — the ASN\'s code; present only on an ASN receipt' })
  asnCode?: string;

  @ApiProperty({
    format: 'uuid',
    required: false,
    description:
      'Story 1-1 — the client whose goods the receipt booked (the PO\'s or ASN\'s client, or a blind receipt\'s chosen or derived client). Absent on a receipt replayed from before 1-1',
  })
  clientId?: string;

  @ApiProperty({ enum: [...BLIND_REASON_ENUM, null], type: String,
    nullable: true })
  blindReasonCode!: string | null;

  @ApiProperty({ description: 'recorded (the v1 terminal state)' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ description: 'Device time (AD-1), ISO-8601 UTC' })
  occurredAt!: string;

  @ApiProperty({ description: 'Server ingest time (AD-1), ISO-8601 UTC' })
  recordedAt!: string;

  @ApiProperty({ type: [GrnLineDto] })
  lines!: readonly GrnLineDto[];

  @ApiProperty({ type: [RejectedGrnLineDto], required: false })
  rejectedLines?: readonly RejectedGrnLineDto[];

  @ApiProperty({
    type: [UnmatchedGrnLineDto],
    required: false,
    description: 'Story 21-6 — present only when some lines of a PO/ASN receipt settled unmatched (booked in full, crediting no document line)',
  })
  unmatchedLines?: readonly UnmatchedGrnLineDto[];

  @ApiProperty({
    required: false,
    description:
      'Story 1-1 — the op id of the review row raised for the refused lines (Conflicts & Reviews, type `grn.lines-refused`, Discard only) — since 1-2a/1-2b every per-line refusal but `shelf-life-short` (which has its own row, `shelfLifeReviewOpId`); present only when one was raised',
  })
  reviewOpId?: string;

  @ApiProperty({
    required: false,
    description:
      'Story 1-2b — the op id of the review row raised for the `shelf-life-short` lines (type `grn.shelf-life-refused` — Accept anyway with a note, or Discard); present only when one was raised',
  })
  shelfLifeReviewOpId?: string;

  @ApiProperty({
    required: false,
    description:
      'Story 1-6d — the op id of the review row raised for the `licence-not-covered` lines (type `grn.licence-refused` — an owner may accept them anyway with a note, or discard them); present only when one was raised',
  })
  licenceReviewOpId?: string;

  @ApiProperty({
    required: false,
    description:
      'Story 1-4b — the op id of the review row raised for the blind or unmatched lines of an INACTIVE SKU this receipt booked (type `grn.inactive-sku-received` — Discard only, labelled Acknowledge; it books nothing); present only when one was raised',
  })
  inactiveSkuReviewOpId?: string;

  @ApiProperty({ required: false, minimum: 1, description: "Story 1-2b — how many booked lines were put on receipt QC holds (the client's QC on receipt); present only when > 0" })
  qcHeldLines?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    description:
      'Story 1-2b — how many booked lines of a QC-on-receipt client were NOT held because the SKU is serial-tracked or catch-weight; present only when > 0',
  })
  qcSkippedLines?: number;
}

/**
 * Story 1-1 (decision 6) — a blind receipt whose EVERY line was refused
 * `sku-client-mismatch`: no receipt was recorded; the lines went to review.
 */
export class RefusedReceiptDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: "The client the blind receipt named — or (story 1-2a), when no client was named, the first refused line's client (a departed one)" })
  clientId!: string;

  @ApiProperty({ enum: [...BLIND_REASON_ENUM, null], type: String, nullable: true })
  blindReasonCode!: string | null;

  @ApiProperty({ description: 'Device time of the receipt (ISO-8601 UTC)' })
  occurredAt!: string;

  @ApiProperty({
    type: [RejectedGrnLineDto],
    description:
      'Every request line, each `sku-client-mismatch` or (story 1-2a) `client-departed` or (story 1-2b) one of the expiry codes (`expiry-on-untracked`, `expiry-before-mfg`, `batch-expiry-mismatch`, `expiry-required`, `shelf-life-short`) or (story 1-6d) `licence-not-covered`',
  })
  rejectedLines!: readonly RejectedGrnLineDto[];

  @ApiProperty({
    required: false,
    description:
      'The op id of the review row (`grn.lines-refused`, Discard only). Story 1-2b: absent when every line was refused `shelf-life-short` (only that row was raised)',
  })
  reviewOpId?: string;

  @ApiProperty({ required: false, description: 'Story 1-2b — the op id of the `grn.shelf-life-refused` review row, when one was raised' })
  shelfLifeReviewOpId?: string;

  @ApiProperty({ required: false, description: 'Story 1-6d — the op id of the `grn.licence-refused` review row, when one was raised' })
  licenceReviewOpId?: string;
}

export class GoodsReceiptResponse {
  @ApiProperty({
    type: GoodsReceiptDto,
    nullable: true,
    description:
      'The recorded GRN. Story 1-1 (decision 6): null when every line of a blind receipt was refused `sku-client-mismatch` — or (story 1-2a) every line of any receipt was refused `sku-client-mismatch` / `client-departed` — no receipt was recorded (no GRN code consumed); `refusedReceipt` then says what went to review',
  })
  goodsReceipt!: GoodsReceiptDto | null;

  @ApiProperty({ type: RefusedReceiptDto, required: false, description: 'Story 1-1 — present only when goodsReceipt is null' })
  refusedReceipt?: RefusedReceiptDto;
}

/** One GRN header of the list read. */
export class GoodsReceiptEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'Server-assigned code (GRN-<n>)' })
  code!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poId!: string | null;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN received against; present only on an ASN receipt' })
  asnId?: string;

  @ApiProperty({ required: false, description: 'Story 21-6 — the ASN\'s code; present only on an ASN receipt' })
  asnCode?: string;

  @ApiProperty({
    format: 'uuid',
    required: false,
    description:
      'Story 1-1 — the client whose goods the receipt booked. Absent on an older receipt the 0076 backfill could not attribute (its lines named several clients, or none)',
  })
  clientId?: string;

  @ApiProperty({ enum: [...BLIND_REASON_ENUM, null], type: String,
    nullable: true, description: 'Set only on a blind receipt' })
  blindReasonCode!: string | null;

  @ApiProperty({ description: 'recorded (the v1 terminal state)' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ description: 'Device time (ISO-8601 UTC)' })
  occurredAt!: string;

  @ApiProperty({ description: 'Server ingest time (ISO-8601 UTC)' })
  recordedAt!: string;

  @ApiProperty({ description: 'Received (sku, batch) lines' })
  lineCount!: number;

  @ApiProperty({ description: 'Physical units across all lines' })
  totalUnits!: number;

  @ApiProperty({ description: 'Units applied immediately (the excess pends)' })
  appliedUnits!: number;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

export class GoodsReceiptListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's goods receipts (a legacy receipt with no client matches through its lines' SKUs). An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Narrow to one warehouse' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({
    required: false,
    type: Boolean,
    description:
      "Story 21-6 — `true`: only BLIND receipts (no PO and no ASN — `blind_reason_code` set); `false`: only document-backed ones (a PO or an ASN). Exactly 'true' or 'false'",
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  blind?: boolean;

  @ApiProperty({
    required: false,
    type: Boolean,
    deprecated: true,
    description:
      "Story 9-1, kept as an ALIAS of `blind` since 21-6 (it means blind — an ASN receipt has no PO but is not blind). Exactly 'true' or 'false'; refused when it disagrees with `blind`",
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  poless?: boolean;

  @ApiProperty({ required: false, format: 'date-time', description: 'Story 9-1 — only receipts whose `created_at` (server time) is at or after this instant. ISO-8601 with a zone designator' })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: 'Story 9-1 — only receipts whose `created_at` is strictly before this instant (exclusive). Must be after `from`' })
  @IsOptional()
  @IsInstant()
  to?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class GoodsReceiptListResponse {
  @ApiProperty({ type: [GoodsReceiptEntryDto] })
  items!: readonly GoodsReceiptEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── over-receipt surfaces ────────────────────────────────────────────────────

/** One over-receipt of the Conflicts & Reviews queue. */
export class OverReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ description: 'The GRN code (server-assigned)' })
  grnCode!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  poId!: string | null;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true, description: 'The PO line the excess pends against — null on an ASN receipt\'s over-receipt, and (story 21-9) on a late receipt\'s line that matched no PO line: approving that credits no line' })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — present only on an ASN receipt\'s over-receipt' })
  asnId?: string;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN line; present only on an ASN receipt\'s over-receipt that names one (story 21-9: absent on a late receipt\'s line that matched no ASN line)' })
  asnLineId?: string;

  @ApiProperty({ required: false, description: 'Story 21-6 — the ASN\'s code; present only on an ASN receipt\'s over-receipt' })
  asnCode?: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  // The schema floor follows the GRN line it derives from (@Min(0.001)): a
  // sub-1 fractional excess is a real queue item, not a schema violation.
  @ApiProperty({ description: `The excess held for approval. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  excessQty!: number;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] })
  status!: 'pending' | 'approved' | 'rejected';

  @ApiProperty({ format: 'uuid' })
  requestedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  requestedAt!: string;

  @ApiProperty({ format: 'uuid', type: String,
    nullable: true })
  decidedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: "Story 1-2b — on an approval's answer only: the receipt QC hold the approved excess was put on (the client's QC on receipt)",
  })
  qcHoldId?: string;
}

export class OverReceiptListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only over-receipts of one client's SKUs. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: ['pending', 'approved', 'rejected'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';

  @ApiProperty({ required: false, format: 'uuid', description: 'Story 9-1 — narrow to one warehouse (404 when it is not this tenant\'s)' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, format: 'date-time', description: 'Story 9-1 — only over-receipts requested (`requested_at`, server time) at or after this instant. ISO-8601 with a zone designator' })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: 'Story 9-1 — only over-receipts requested strictly before this instant (exclusive). Must be after `from`' })
  @IsOptional()
  @IsInstant()
  to?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class OverReceiptListResponse {
  @ApiProperty({ type: [OverReceiptDto] })
  items!: readonly OverReceiptDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class OverReceiptDecisionResponse {
  @ApiProperty({ type: OverReceiptDto })
  overReceipt!: OverReceiptDto;
}

// ── device catalog snapshot ──────────────────────────────────────────────────

export class CatalogSnapshotQuery {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the snapshot is scoped to' })
  @IsUUID()
  warehouseId!: string;
}

/**
 * Story 1-4 — one non-primary barcode of a snapshot SKU: a pack level's
 * barcode (a case, a pallet) or an extra base-level barcode (factor 1).
 */
export class CatalogSnapshotPackBarcodeDto {
  @ApiProperty({ example: '8901234567890' })
  barcode!: string;

  @ApiProperty({ example: 'case', enum: [...UOMS], description: 'The level this barcode names — the SKU\'s base uom, or one of its pack levels' })
  uom!: string;

  @ApiProperty({
    example: 12,
    minimum: 1,
    description:
      'Base units one scan of this barcode counts: the pack level\'s factor, or 1 at the base uom. The handheld adds it on receive, returns and pack; pick and putaway accept the barcode as SKU confirmation only.',
  })
  factor!: number;
}

/** Story 1-6a — a snapshot SKU's dangerous-goods identity. */
export class CatalogSnapshotDgDto {
  @ApiProperty({ example: '1230', description: 'The UN number, four digits without the "UN" prefix' })
  unNumber!: string;

  @ApiProperty({ example: '3', enum: [...DG_CLASSES], description: 'The primary DG class' })
  class!: string;

  @ApiProperty({ type: [String], enum: [...DG_CLASSES], example: ['6.1'], description: 'Up to two subsidiary DG classes, sorted' })
  subsidiaryClasses!: string[];

  @ApiProperty({ type: String, nullable: true, enum: [...DG_PACKING_GROUPS], example: 'II', description: 'The UN packing group, or null' })
  packingGroup!: string | null;
}

/** One SKU of the device snapshot's barcode map. */
export class CatalogSnapshotSkuDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  barcode!: string;

  @ApiProperty({ example: 'each', enum: [...UOMS] })
  uom!: string;

  @ApiProperty({
    example: 0,
    minimum: 0,
    maximum: QUANTITY_DECIMALS,
    description:
      'Decimal places this SKU\'s base UoM may express (each = 0, kg = 3). The device validates entry against it OFFLINE, inside the Rejected banner, so a too-precise scan is refused before it is ever queued.',
  })
  uomPrecision!: number;

  @ApiProperty()
  batchTracked!: boolean;

  @ApiProperty()
  serialTracked!: boolean;

  @ApiProperty({
    description:
      'Story 10.3: the SKU is handled by unit and priced by weight. It rides the snapshot so the device can PROMPT for a per-unit weight at receipt while offline — a prompt only the server knows about never happens on the floor.',
  })
  catchWeightTracked!: boolean;

  @ApiProperty({
    type: Object,
    nullable: true,
    example: { size: 'M', colour: 'Red' },
    description:
      'Story 11.7: this SKU\'s values on its product\'s declared variant axes, null when the SKU is unattached. Rides the snapshot so the device can SAY which variant a pick scan holds, offline (UX-DR28).',
  })
  variantValues!: Record<string, string> | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    example: ['size', 'colour'],
    description:
      'Story 11.7: the attached product\'s declared variant axes, in declaration order — the order a variant label is read in. Null when the SKU is unattached.',
  })
  axes!: string[] | null;

  @ApiProperty({
    enum: [...STORAGE_CLASSES],
    example: 'ambient',
    description:
      'Story 12.8 (UX-DR29): the SKU\'s storage class (defaults to `ambient`). It rides the snapshot beside the bin arm\'s class so the device\'s offline conformance mirror can refuse a non-conforming placement or draw in the Rejected banner — a refusal only the server knew about would queue in a dead zone and come back hours later as a rejection the operator can no longer act on.',
  })
  storageClass!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Story 1-1: the client the SKU belongs to. Code and barcode are unique per (tenant, client), so one barcode may name several SKUs; the device resolves a scan through the work\'s own SKUs first, then the document\'s client (`clients` names each)',
  })
  clientId!: string;

  @ApiProperty({
    type: [CatalogSnapshotPackBarcodeDto],
    description:
      'Story 1-4: every non-primary barcode of the SKU with its level and factor (1 at the base uom). Empty when the SKU has none; an older device ignores it.',
  })
  packBarcodes!: CatalogSnapshotPackBarcodeDto[];

  @ApiProperty({
    enum: ['active', 'inactive'],
    description:
      'Story 1-4b: `inactive` — the SKU takes no new inbound. A receive scan of it that is not on the document is still booked and flagged for review; the handheld warns at scan time. An older device ignores it.',
  })
  status!: 'active' | 'inactive';

  @ApiProperty({ description: 'Story 1-6a: handle with care — the handheld notes it on receive, pick, pack and putaway' })
  fragile!: boolean;

  @ApiProperty({ description: 'Story 1-6a: a handling and insurance marker — noted on the handheld, never a placement rule' })
  highValue!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 100,
    description: 'Story 1-6a: how many of the SKU\'s outermost received units may stand on one another (1 = do not stack); shown, not enforced',
  })
  maxStackLayers!: number | null;

  @ApiProperty({
    type: CatalogSnapshotDgDto,
    nullable: true,
    description: 'Story 1-6a: the dangerous-goods identity, null when the SKU is not a dangerous good',
  })
  dg!: CatalogSnapshotDgDto | null;
}


/**
 * Story 1-2b — a client's receiving policy as the device snapshot carries it
 * (the `GET …/clients/{c}/receiving-policy` fields; declared here because a
 * module DTO never imports the api shell).
 */
export class CatalogClientReceivingPolicyDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 10000, description: 'Over-receipt tolerance, basis points of the ordered / announced quantity (500 = 5 %)' })
  receivingToleranceBps!: number;

  @ApiProperty({ description: 'Booked lines are put on receipt QC holds' })
  qcOnReceipt!: boolean;

  @ApiProperty({ description: 'A batch-tracked line needs an expiry date' })
  expiryRequired!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Minimum remaining shelf life in IST calendar days, or null' })
  minShelfLifeDays!: number | null;
}

/** Story 1-1 — one client named by the device snapshot (a SKU's or an open document's). */
export class CatalogSnapshotClientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The client code (the tenant\'s own client\'s is `self`)' })
  code!: string;

  @ApiProperty({ description: 'The display name (the tenant\'s own client carries the tenant\'s name)' })
  name!: string;

  @ApiProperty({ description: 'False when suspended or departed — a blind receipt picks only an active client' })
  active!: boolean;

  @ApiProperty({
    type: () => CatalogClientReceivingPolicyDto,
    required: false,
    description:
      'Story 1-2b — the client\'s receiving policy, so the handheld can WARN at the dock (it never blocks; the server decides on replay). Absent = the device warns about nothing',
  })
  receivingPolicy?: CatalogClientReceivingPolicyDto;
}

/** One open PO of the device snapshot (header + line quantities). */
export class CatalogSnapshotPoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ format: 'uuid', description: 'Story 1-1 (additive): the PO\'s client — the device resolves an unmatched scan within it' })
  clientId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  vendorId!: string;

  @ApiProperty({ description: "Story 1-3 — the vendor's name as the PO froze it (the handheld's receive card shows it; an older server omits it)" })
  vendorName!: string;

  @ApiProperty({ type: [PurchaseOrderLineDto], description: 'Per-line ordered / received / open quantities' })
  lines!: readonly PurchaseOrderLineDto[];
}

/** Story 21-6 — one line of an open ASN on the device snapshot. */
export class CatalogSnapshotAsnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: `Announced quantity. ${QUANTITY_FIELD_DESCRIPTION}` })
  announcedQty!: number;

  @ApiProperty({ description: 'Received to date, in base UoM', minimum: 0 })
  receivedQty!: number;

  @ApiProperty({ description: 'Derived: announcedQty − receivedQty, clamped at 0 for display (story 1-2b — received may pass announced after an approved over-receipt or a within-tolerance receipt)', minimum: 0 })
  openQty!: number;
}

/** Story 21-6 — one open (announced or partially received) ASN of the device snapshot. */
export class CatalogSnapshotAsnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The client-supplied ASN code' })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'When the shipment is expected (ISO-8601 UTC), null when unannounced' })
  expectedAt!: string | null;

  @ApiProperty({ type: [CatalogSnapshotAsnLineDto] })
  lines!: readonly CatalogSnapshotAsnLineDto[];
}

/** One pack task of the device snapshot (story 10.7, additive) — the bench's unit of work. */
export class CatalogPackTaskDto {
  @ApiProperty({ format: 'uuid', description: 'The fully-picked, still-accepted order' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({
    description:
      'What the order actually had PICKED of this SKU, in base units — from the same grouped-picks read the pack command verifies against. The bench scans to EXACTLY this; a whole count at the bench.',
  })
  pickedQty!: number;

  @ApiProperty({
    description:
      'Story 10.3: the SKU is handled by unit — the bench must scan each case\'s handling-unit label (count == pickedQty), never a typed quantity.',
  })
  catchWeightTracked!: boolean;
}

/** One active handling unit of the device snapshot (story 10.7, additive). */
export class CatalogHandlingUnitDto {
  @ApiProperty({ format: 'uuid', description: 'The unit label the bench scans' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the unit belongs to' })
  skuId!: string;
}

/**
 * One line of the device snapshot's Transfer inbox task (story 5-1, additive)
 * — a planned landing bin + its epoch, the confirm's scan pre-fill.
 */
export class CatalogTransferTaskLineDto {
  @ApiProperty({ format: 'uuid' })
  lineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty({ description: `Base units to land. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0.001 })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The catalog batch identity on a batch-tracked line' })
  batchRef!: string | null;

  @ApiProperty({ format: 'uuid', description: 'The PLANNED destination bin — the confirm scan pre-fills from it' })
  destBinId!: string;

  @ApiProperty()
  destBinCode!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'The dest bin\'s state epoch, captured with the task' })
  binStateEpoch!: number | null;
}

/** One in-transit transfer of the device snapshot (story 5-1, additive) — the Transfer inbox task. */
export class CatalogTransferTaskDto {
  @ApiProperty({ format: 'uuid', description: 'The transfer order awaiting inbound confirm' })
  transferId!: string;

  @ApiProperty({ format: 'uuid', description: 'The warehouse the units came from' })
  sourceWarehouseId!: string;

  @ApiProperty()
  sourceWarehouseCode!: string;

  @ApiProperty()
  sourceWarehouseName!: string;

  @ApiProperty({ format: 'uuid' })
  destWarehouseId!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ description: 'When the outbound confirm put the units in transit (ISO-8601 UTC)' })
  outboundConfirmedAt!: string;

  @ApiProperty({ type: [CatalogTransferTaskLineDto] })
  lines!: readonly CatalogTransferTaskLineDto[];
}

/**
 * One line of the device snapshot's Count inbox task (story 5-3, additive)
 * — the FROZEN expectation the operator counts against.
 */
export class CatalogCountTaskLineDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty({ description: `The expectation frozen at task start. ${QUANTITY_FIELD_DESCRIPTION}`, minimum: 0 })
  expectedQuantity!: number;
}

/** One stored count task of the device snapshot (story 5-3, additive) — the Count inbox task. */
export class CatalogCountTaskDto {
  @ApiProperty({ format: 'uuid', description: 'The count task awaiting submit' })
  taskId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty({ description: 'The bin the count walks (the scan that opens the flow)' })
  binCode!: string;

  @ApiProperty({ enum: ['on_demand', 'scheduled', 'recount'], description: 'How the task was born' })
  origin!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The bin state epoch FROZEN at task start — the submit quotes it back for the equality compare',
  })
  binStateEpoch!: number | null;

  @ApiProperty({ description: 'When the task was created (ISO-8601 UTC)' })
  createdAt!: string;

  @ApiProperty({ type: [CatalogCountTaskLineDto], description: 'The FROZEN expectations — every line must be counted at submit' })
  lines!: readonly CatalogCountTaskLineDto[];
}

/**
 * Story 13-2 — one authorized serial of an open return's line, as the device
 * snapshot carries it. Declared here (beside the snapshot) rather than
 * imported: only the api shell may import the returns module, which composes
 * the arm through `ReturnsFacade.getOpenReturns`.
 */
export class CatalogOpenReturnSerialDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  serialNumber!: string;

  @ApiProperty({ description: 'Already received against this authorization' })
  received!: boolean;

  @ApiProperty({ type: String, nullable: true, description: "The batch the serial was picked from (batch-and-serial SKUs); null otherwise" })
  batchCode!: string | null;
}

export class CatalogOpenReturnLineDto {
  @ApiProperty({ format: 'uuid', description: 'The return authorization line (an entry\'s rmaLineId)' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Units authorized, base UoM' })
  authorizedQty!: number;

  @ApiProperty({ description: 'Units received so far, base UoM' })
  receivedQty!: number;

  @ApiProperty({ description: 'authorized − received, base UoM' })
  openQty!: number;

  @ApiProperty({ type: [String], description: 'Batch-tracked SKUs: the batches the order line was picked from (a receipt names one of them); empty otherwise' })
  batchCodes!: readonly string[];

  @ApiProperty({ type: [CatalogOpenReturnSerialDto], description: 'Serial-tracked lines: every authorized serial, sorted by number; empty otherwise' })
  serials!: readonly CatalogOpenReturnSerialDto[];
}

export class CatalogOpenReturnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'RMA-0001' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, description: "The order's channel reference; null for a manual order" })
  orderReference!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Story 1-1 (additive): the order\'s client — the device resolves a typed code within it after the RMA\'s own lines' })
  clientId!: string;

  @ApiProperty({ type: [CatalogOpenReturnLineDto] })
  lines!: readonly CatalogOpenReturnLineDto[];
}

export class CatalogSnapshotResponse {
  @ApiProperty({ description: 'ISO-8601 UTC capture time' })
  generatedAt!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: [CatalogSnapshotSkuDto] })
  skus!: readonly CatalogSnapshotSkuDto[];

  @ApiProperty({ type: [CatalogSnapshotPoDto], description: 'The warehouse\'s open POs with their lines' })
  openPurchaseOrders!: readonly CatalogSnapshotPoDto[];

  @ApiProperty({
    type: [CatalogSnapshotAsnDto],
    description:
      'Story 21-6 (additive): the warehouse\'s open advance shipment notices (announced or partially received) with per-line announced / received / open — receiving books against them exactly as against a PO',
  })
  openAsns!: readonly CatalogSnapshotAsnDto[];

  @ApiProperty({ type: [PutawayBinDto], description: 'Story 3.5 (additive): every bin of the warehouse — blocked/system bins included so the device can reject a scan against them pre-queue' })
  bins!: readonly PutawayBinDto[];

  @ApiProperty({ type: [PutawayTaskDto], description: 'Story 3.5 (additive): the derived putaway tasks with the capacity-only suggestions (advisory — the server re-gates at placement)' })
  putawayTasks!: readonly PutawayTaskDto[];

  @ApiProperty({ type: [PickTaskDto], description: 'Story 4.3 (additive): the pick tasks of every ready picklist on a released wave, in walk order (the bin/batch each names is advisory — the server re-derives both at pick time)' })
  pickTasks!: readonly PickTaskDto[];

  @ApiProperty({ type: [CatalogPackTaskDto], description: 'Story 10.7 (additive): the packable orders\' per-SKU picked totals — the dataset the bench pre-verifies its scan against, offline. Mirrors the pack command\'s own verification query (picks grouped by (order, sku)) and its completeness guards (accepted, ≥1 pick line, none planned, not all cancelled)' })
  packTasks!: readonly CatalogPackTaskDto[];

  @ApiProperty({ type: [CatalogHandlingUnitDto], description: 'Story 10.7 (additive): every ACTIVE handling unit of the warehouse (id + skuId) — the labels a catch-weight bench scan resolves against, offline. Active-only self-prunes (units flip to packed at pack)' })
  handlingUnits!: readonly CatalogHandlingUnitDto[];

  @ApiProperty({ type: [CatalogTransferTaskDto], description: 'Story 5-1 (additive): the in-transit transfers TO this warehouse — the Transfer inbox tasks whose inbound confirm the operator executes (one confirm completes the whole order)' })
  transferTasks!: readonly CatalogTransferTaskDto[];

  @ApiProperty({
    type: [CatalogCountTaskDto],
    description:
      'Story 5-3 (additive): the STORED pending count tasks of this warehouse — the Count inbox tasks whose submit the operator executes (every task line must be counted; 0 is a valid explicit count). The expectations were FROZEN at task start and are read here, never recomputed',
  })
  countTasks!: readonly CatalogCountTaskDto[];

  @ApiProperty({
    type: [CatalogOpenReturnDto],
    description:
      'Story 13-2 (additive): the warehouse\'s return authorizations that can still receive (open or partially received) — the handheld receives returned units against them offline, grading each unit; units not on an authorization are queued for review, never refused on the device',
  })
  openReturns!: readonly CatalogOpenReturnDto[];

  @ApiProperty({
    type: [CatalogSnapshotClientDto],
    description:
      'Story 1-1 (additive): every client referenced by a SKU or an open document of the snapshot — the names the device shows when a scan belongs to another client, and the blind receipt\'s client picker. A snapshot WITHOUT this field (an older server) puts the device in legacy mode: no picker, no clientId sent',
  })
  clients!: readonly CatalogSnapshotClientDto[];
}
