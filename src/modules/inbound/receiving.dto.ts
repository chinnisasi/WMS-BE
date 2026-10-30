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
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BooleanFlag, IsInstant } from '../../shared/primitives/instant-range';
import { PurchaseOrderLineDto } from './inbound.dto';
import {
  MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  MAX_HANDLING_UNITS_PER_REQUEST,
} from '../catalog/handling-unit';
import { MAX_HANDLING_UNITS_PER_GRN_LINE, REJECTED_GRN_LINE_CODES, UNMATCHED_LINE_REASONS } from './receiving.command';
import { DAMAGE_REASON_CODES, SHORT_REASON_CODES } from './receipt-condition';
import { RECEIPT_PHOTOS_MAX_PER_LINE } from '../attachments/attachment-records';
import { GRN_LINE_SERIAL_STATES, MAX_GRN_SERIALS_PER_LINE, SERIAL_FORMATS } from '../../shared/primitives/serial';
import { ADJUSTMENT_REASON_CODES } from '../inventory/inventory.facade';
import { BATCH_EXPIRY_SOURCES } from '../catalog/catalog.facade';
// Story 3.5 (additive): the snapshot's putaway decision fields reuse the
// putaway module's DTOs (one shape on every surface).
import { PutawayBinDto, PutawayTaskDto } from '../putaway/putaway.dto';
import { PickTaskDto } from '../outbound/outbound.dto';
// Story 2-3a — the gate-in link and the snapshot's open gate-ins.
import { CatalogOpenGateInDto, GateInLinkDto } from './gate-in.dto';
import { CatalogDockAppointmentDto } from './dock.dto';

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
    description:
      "Optional batch mfg date (ISO-8601 UTC, Z-suffixed). Story 2-4b — a date-only mfg is sent as its date at midnight UTC (`YYYY-MM-DDT00:00:00Z`); ONLY that shape feeds the shelf-life derivation (a batch-tracked line with no typed expiry gets expiry = the mfg's IST date + the SKU's shelfLifeDays). Any other instant is stored as before and derives nothing (a pre-2-4b handheld's misread date arrives as an IST-midnight instant)",
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
    description: `The GOOD units received (story 2-4a — damaged units go in damagedQty, never here; 0 on an all-damaged line, but every line needs qty + damagedQty > 0). ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
    description:
      'Story 2-4a — units that arrived DAMAGED, booked into the warehouse\'s system DAMAGED bin (not sellable) and never crediting the PO or ASN line. Needs damageReasonCode when > 0. Refused (400) on a serial-tracked or catch-weight SKU. Omit (or 0) when none',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  damagedQty?: number | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: [...DAMAGE_REASON_CODES, null],
    description: 'Story 2-4a — why the damaged units are damaged; given exactly when damagedQty > 0',
  })
  @IsOptional()
  @IsIn(DAMAGE_REASON_CODES as unknown as string[])
  damageReasonCode?: string | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
    description:
      "Story 2-4a — units the supplier's invoice or challan listed that never arrived, typed at the dock. Recorded on the line only — no stock and no effect on the PO or ASN. Needs shortReasonCode when > 0. Omit (or 0) when none",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  shortQty?: number | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    enum: [...SHORT_REASON_CODES, null],
    description: 'Story 2-4a — why the units are short; given exactly when shortQty > 0',
  })
  @IsOptional()
  @IsIn(SHORT_REASON_CODES as unknown as string[])
  shortReasonCode?: string | null;

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

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: RECEIPT_PHOTOS_MAX_PER_LINE,
    description:
      "Story 2-5a — the line's damage photos, by the ULID the handheld minted at capture (each photo's own upload op's Idempotency-Key), in capture order. At most 10 per line and 50 per receipt, unique across the receipt. A photo uploaded first is attached by this receipt; one that arrives later fills the placeholder this receipt leaves. A ref that is unknown to this device, or already bound, is skipped — never a refusal. Omit when the line has none (an empty array means the same)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECEIPT_PHOTOS_MAX_PER_LINE)
  @IsString({ each: true })
  @Matches(/^[0-9A-HJKMNP-TV-Z]{26}$/, { each: true, message: 'each photoRefs entry must be a 26-character ULID' })
  photoRefs?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    nullable: true,
    maxItems: MAX_GRN_SERIALS_PER_LINE,
    description:
      "Story 2-6a — the line's serial numbers (one per GOOD unit, in capture order), required on a serial-tracked SKU's line and refused on any other: `qty` must equal the count. Each is trimmed, then must be 1–64 printable ASCII characters with no whitespace; case-sensitive; none may repeat for the same SKU across the receipt; ≤ 500 per line (with unreadableSerialQty) and ≤ 1,000 per receipt — each a 400. On an `imei` SKU each must be a 15-digit, Luhn-valid IMEI. A serial already in stock, in transit, on a pending over-receipt, dispatched on an order, blocked, or (imei) badly formed is refused PER SERIAL into `rejectedLines` (`serialsOnly`) and the rest of the line books. Omit (or send an empty array) when the line has none",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GRN_SERIALS_PER_LINE)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  serials?: string[] | null;

  @ApiProperty({
    required: false,
    type: 'integer',
    nullable: true,
    minimum: 0,
    maximum: MAX_GRN_SERIALS_PER_LINE,
    description:
      "Story 2-6a — units of a serial-tracked line whose serial could not be read: RECORDED on the line, never booked or credited (set them aside and report). Needs at least one serial on the line; counts toward the 500-per-line cap. Omit (or 0) when none",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_GRN_SERIALS_PER_LINE)
  unreadableSerialQty?: number | null;
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

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Story 2-3a — the gate-in (the vehicle visit) this receipt came off. NEVER refused (decision 5): an unknown id, a non-uuid or another warehouse\'s gate-in books the receipt UNLINKED and the answer says why in `gateInLink`; a gated-out gate-in links. Absent: the receipt books exactly as before',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  gateInId?: string;

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

/** Story 2-4b — an expiry the receipt derived from the mfg date and the SKU's shelf life. */
export class DerivedExpiryDto {
  @ApiProperty({ example: '2027-02-28', description: 'The derived expiry (YYYY-MM-DD, IST)' })
  expiryDate!: string;

  @ApiProperty({ example: '2026-09-01', description: 'The mfg date it was derived from (YYYY-MM-DD, IST) — the batch\'s stored mfg, else the first line\'s' })
  mfgDate!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 3650, example: 180, description: "The SKU's shelf life used, in days from manufacture" })
  shelfLifeDays!: number;
}

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

  // Story 2-4a: the GOOD units, 0 on an all-damaged line (the floor follows
  // the receipt validator, @Min(0)).
  @ApiProperty({ description: 'The good units that arrived (story 2-4a — damaged units are damagedQty; 0 on an all-damaged line)', minimum: 0 })
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

  @ApiProperty({ required: false, minimum: 0, description: 'Story 2-4a — the units that arrived damaged, booked into the system DAMAGED bin (not sellable). Present only when > 0' })
  damagedQty?: number;

  @ApiProperty({ required: false, enum: [...DAMAGE_REASON_CODES], description: 'Story 2-4a — why; present only beside damagedQty' })
  damageReasonCode?: string;

  @ApiProperty({ required: false, minimum: 0, description: "Story 2-4a — the units short against the supplier's document (recorded only). Present only when > 0" })
  shortQty?: number;

  @ApiProperty({ required: false, enum: [...SHORT_REASON_CODES], description: 'Story 2-4a — why; present only beside shortQty' })
  shortReasonCode?: string;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Catch weight (story 10.3): the handling units this line produced, in the order their weights were supplied — present only on a catch-weight line. These ids are what a unit label carries and what the pack bench scans back.',
  })
  handlingUnitIds?: readonly string[];

  @ApiProperty({ required: false, type: [String], description: 'Story 2-6a — the serial numbers this line BOOKED now (one `grn.received` each), in capture order; present only on a serial line that booked some' })
  serials?: readonly string[];

  @ApiProperty({ required: false, type: [String], description: "Story 2-6a — the serial numbers set aside on this line's over-receipt (they book, in order, when it is approved); present only when some pend" })
  pendingSerials?: readonly string[];

  @ApiProperty({ required: false, type: 'integer', minimum: 1, description: 'Story 2-6a — units recorded without a readable serial (not booked); present only when > 0' })
  unreadableSerialQty?: number;

  @ApiProperty({ required: false, enum: ['serial-tracked'], description: "Story 2-6a — present on a serial line of a QC-on-receipt client's receipt: it booked UNHELD (QC on receipt does not hold serial-tracked lines)" })
  qcSkipped?: 'serial-tracked';

  @ApiProperty({
    required: false,
    type: () => DerivedExpiryDto,
    description:
      "Story 2-4b — present only when this receipt DERIVED the line's batch expiry: no line typed one and the batch had none, so it is the mfg's IST date + the SKU's shelf life",
  })
  derivedExpiry?: DerivedExpiryDto;

  @ApiProperty({
    required: false,
    example: '2027-02-28',
    description: "Story 2-4b — present only when a typed expiry on this receipt REPLACED the batch's earlier derived one: that derived date (YYYY-MM-DD, IST)",
  })
  replacedDerivedExpiry?: string;
}

/** Story 2-6a — where one refused serial is (in stock / in transit), or the other IMEI SKU that holds it. */
export class RejectedSerialDetailDto {
  @ApiProperty({ description: 'The refused serial number, as sent (trimmed)' })
  serial!: string;

  @ApiProperty({ required: false, description: 'The bin code it is in (in stock), or the in-transit bin' })
  binCode?: string;

  @ApiProperty({ required: false, description: "That bin's warehouse code" })
  warehouseCode?: string;

  @ApiProperty({ required: false, description: 'An imei SKU: the OTHER SKU this IMEI is held under' })
  skuCode?: string;
}

/** Story 1-6d — one need of a `licence-not-covered` line that no valid licence covers. */
export class MissingLicenceDto {
  @ApiProperty({ enum: [...LICENCE_NEEDS], description: 'What the goods need: drug-20b (G/H/H1), drug-21b (C/C1), drug-20g (X), ndps, or fssai (food)' })
  need!: LicenceNeed;

  @ApiProperty({ enum: [...LICENCE_HOLDERS], description: '`client` — the brand holds no valid licence for this site (or for none); `site` — the site holds no valid licence' })
  holder!: LicenceHolder;

  @ApiProperty({ required: false, description: 'The receipt\'s site code — the site a site licence is missing at, or a client licence is missing for' })
  siteCode?: string;
}

/** One line the server refused to settle (naming the reason — the others settle). */
export class RejectedGrnLineDto {
  @ApiProperty({ format: 'uuid', type: String, nullable: true, description: 'The PO line named — null on an ASN line rejection' })
  poLineId!: string | null;

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 21-6 — the ASN line named; present only on an ASN line rejection' })
  asnLineId?: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ minimum: 0, description: 'The line\'s good units, as sent (story 2-4a — 0 on an all-damaged line)' })
  qty!: number;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 2-4a — the refused line\'s damaged units, as sent (not booked — the line went to review whole). Present only when > 0' })
  damagedQty?: number;

  @ApiProperty({ required: false, enum: [...DAMAGE_REASON_CODES], description: 'Story 2-4a — present only beside damagedQty' })
  damageReasonCode?: string;

  @ApiProperty({ required: false, minimum: 0, description: 'Story 2-4a — the refused line\'s short units, as sent. Present only when > 0' })
  shortQty?: number;

  @ApiProperty({ required: false, enum: [...SHORT_REASON_CODES], description: 'Story 2-4a — present only beside shortQty' })
  shortReasonCode?: string;

  @ApiProperty({
    enum: [...REJECTED_GRN_LINE_CODES],
    description:
      'Machine reason. Only an OPEN document rejects a line. `po-line-not-open` is defensive since story 21-9 (an open PO has no cancelled or carried line) and stays in the enum for older clients. Story 1-1: `sku-client-mismatch` — a BLIND receipt\'s line whose SKU belongs to another client than the receipt\'s; it goes to the review queue (Discard only). Story 1-2a: `client-departed` — a line of ANY receipt whose SKU\'s client has departed; also to review (Discard only — re-receive after an owner reactivates the client). Story 1-2b — the expiry rules, each per line: `expiry-on-untracked`, `expiry-before-mfg`, `batch-expiry-mismatch`, `expiry-required` (review, Discard only) and `shelf-life-short` (its own review row — Accept anyway with a note, or Discard). Story 1-6d: `licence-not-covered` — licence enforcement is on and no valid client and site licence covers the line\'s drug or food goods on the receipt\'s IST date; its own review row (`grn.licence-refused` — an owner may accept it anyway with a note, or discard it). Story 2-6a — serial capture, all to `grn.lines-refused` (Discard only): the WHOLE line is refused `serials-required` (a serial-tracked SKU sent without serials — an older build or queued op) or `serials-on-untracked` (serials on a SKU that is not serial-tracked); PER SERIAL (`serialsOnly`, the rest books — or the whole line when every serial is refused): `serial-format-invalid` (not a valid IMEI on an imei SKU), `serial-in-stock` (on hand in any bin of any warehouse, or — imei — under another imei SKU), `serial-in-transit` (on a transfer), `serial-pending-approval` (on another receipt\'s open over-receipt), `serial-dispatched-use-returns` (it left on an order — receive it as a return) and `serial-blocked`',
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

  @ApiProperty({ required: false, type: [String], description: "Story 2-6a — the refused serial numbers (a serial refusal), or the refused line's serials (a `serials-*` line refusal)" })
  serials?: readonly string[];

  @ApiProperty({ required: false, enum: [true], description: 'Story 2-6a — ONLY these serials of line `index` were refused; the rest of the line booked (qty = the refused count)' })
  serialsOnly?: true;

  @ApiProperty({ required: false, type: [RejectedSerialDetailDto], description: 'Story 2-6a — per refused serial: where it is, or the other IMEI SKU holding it' })
  serialDetails?: readonly RejectedSerialDetailDto[];

  @ApiProperty({ required: false, type: 'integer', minimum: 1, description: "Story 2-6a — a whole-line refusal's unreadable units (not booked); present only when > 0" })
  unreadableSerialQty?: number;

  @ApiProperty({
    required: false,
    type: () => DerivedExpiryDto,
    description:
      'Story 2-4b — present only on an expiry refusal whose judged expiry the receipt DERIVED from mfg + shelf life (`shelf-life-short`, or a `batch-expiry-mismatch` after a concurrent receipt set the batch\'s expiry first)',
  })
  derivedExpiry?: DerivedExpiryDto;
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

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 2-3a — the gate-in the receipt is linked to; present only when linked' })
  gateInId?: string;

  @ApiProperty({ required: false, example: 'GI-0001', description: "Story 2-3a — the linked gate-in's code; present only when linked" })
  gateInCode?: string;

  @ApiProperty({ type: GateInLinkDto, required: false, description: 'Story 2-3a — present only when the receipt named a gate-in that did NOT link (it booked unlinked)' })
  gateInLink?: GateInLinkDto;

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

  @ApiProperty({
    required: false,
    type: () => [GoodsReceiptRecalledLotDto],
    description:
      'Story 3-7a — the booked lots that sit on an open live recall: the receipt is booked and the lot stays blocked — keep the units apart. Present only when there is one',
  })
  recalledLots?: readonly GoodsReceiptRecalledLotDto[];
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

  @ApiProperty({ type: GateInLinkDto, required: false, description: 'Story 2-3a — present only when the receipt named a gate-in that did not link (nothing was recorded, so nothing linked)' })
  gateInLink?: GateInLinkDto;
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

  @ApiProperty({ format: 'uuid', required: false, description: 'Story 2-3a — the gate-in the receipt is linked to; present only when linked' })
  gateInId?: string;

  @ApiProperty({ required: false, example: 'GI-0001', description: "Story 2-3a — the linked gate-in's code" })
  gateInCode?: string;

  @ApiProperty({ required: false, example: 'KA01AB1234', description: "Story 2-3a — the linked gate-in's vehicle; present only when linked and the gate-in has one (a hand delivery has none)" })
  vehicleNo?: string;

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

  @ApiProperty({ description: 'The good units across all lines (story 2-4a — damaged units are damagedUnits)' })
  totalUnits!: number;

  @ApiProperty({ description: 'Units applied immediately (the excess pends)' })
  appliedUnits!: number;

  @ApiProperty({ minimum: 0, description: 'Story 2-4a — the damaged units across all lines (booked into the system DAMAGED bin); 0 when none' })
  damagedUnits!: number;

  @ApiProperty({ minimum: 0, description: "Story 2-4a — the units short against the supplier's documents across all lines (recorded only); 0 when none" })
  shortUnits!: number;

  @ApiProperty({ minimum: 0, description: "Story 2-5a — the receipt's attached damage photos across all lines; 0 when none" })
  photoCount!: number;

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

/** Story 2-4a — one GRN line of the web's expandable GRN row (base units). */
export class GoodsReceiptLineEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-01', description: "Story 2-4b — the batch's mfg date (YYYY-MM-DD, IST); null when unset or no batch" })
  batchMfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2027-02-28', description: "Story 2-4b — the batch's expiry date (YYYY-MM-DD, IST); null when unset or no batch" })
  batchExpiryDate!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...BATCH_EXPIRY_SOURCES, null],
    description:
      "Story 2-4b — where the batch's expiry came from: `derived` (mfg + the SKU's shelf life — shown as \"from shelf life\"), `typed` (a receipt line's label date), or null (no expiry, or set before 2-4b / outside a receipt)",
  })
  expirySource!: 'typed' | 'derived' | null;

  @ApiProperty({ minimum: 0, description: 'The good units (0 on an all-damaged line)' })
  qty!: number;

  @ApiProperty({ minimum: 0, description: 'The good units applied at once (the rest pended as an over-receipt)' })
  appliedQty!: number;

  @ApiProperty({ required: false, minimum: 0, description: 'The damaged units, booked into the system DAMAGED bin — present only when > 0' })
  damagedQty?: number;

  @ApiProperty({ required: false, enum: [...DAMAGE_REASON_CODES], description: 'Present only beside damagedQty' })
  damageReasonCode?: string;

  @ApiProperty({ required: false, minimum: 0, description: "The units short against the supplier's document (recorded only) — present only when > 0" })
  shortQty?: number;

  @ApiProperty({ required: false, enum: [...SHORT_REASON_CODES], description: 'Present only beside shortQty' })
  shortReasonCode?: string;

  @ApiProperty({ minimum: 0, description: "Story 2-5a — the line's attached damage photos" })
  photoCount!: number;

  @ApiProperty({ minimum: 0, description: "Story 2-5a — the line's photos the receipt named that have not arrived yet (awaited)" })
  pendingPhotoCount!: number;

  @ApiProperty({ required: false, type: () => [GrnLineSerialEntryDto], description: "Story 2-6a — the line's captured serials in capture order, each with its state; present only on a line that captured serials" })
  serials?: readonly GrnLineSerialEntryDto[];

  @ApiProperty({ required: false, type: 'integer', minimum: 1, description: 'Story 2-6a — units recorded without a readable serial (not booked); present only when > 0' })
  unreadableSerialQty?: number;

  @ApiProperty({ required: false, enum: ['serial-tracked'], description: "Story 2-6a — QC on receipt was skipped for this serial line (it booked unheld; derived: serial rows, no receipt hold, and the receipt's client has QC on receipt NOW)" })
  qcSkipped?: 'serial-tracked';

  @ApiProperty({ required: false, example: 'RCL-000001', description: "Story 3-7a — the OPEN LIVE recall naming this line's lot (the lot stays blocked — keep the units apart); present only when one does" })
  recallCode?: string;
}

/** Story 3-7a (A14) — a booked lot that sits on an open live recall. */
export class GoodsReceiptRecalledLotDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;

  @ApiProperty()
  batchCode!: string;

  @ApiProperty({ example: 'RCL-000001' })
  recallCode!: string;
}

/** Story 2-6a — one captured serial of a GRN line as the web reads it. */
export class GrnLineSerialEntryDto {
  @ApiProperty({ description: 'The serial number (IMEI 1 on an imei SKU)' })
  serial!: string;

  @ApiProperty({
    enum: GRN_LINE_SERIAL_STATES.filter((state) => state !== 'unreadable'),
    description: '`applied` — booked; `pending` — awaiting the over-receipt approval; `rejected` — that approval was rejected',
  })
  state!: 'applied' | 'pending' | 'rejected';

  @ApiProperty({ required: false, enum: [true], description: 'Present when this serial was received again after a write-off' })
  afterWriteOff?: true;
}

/** Story 2-5a — the device snapshot's damage-photo arm. */
export class CatalogReceiptPhotosDto {
  @ApiProperty({ description: 'False under FILE_STORE=none — the handheld hides its Photo button' })
  enabled!: boolean;

  @ApiProperty({ description: 'The live photos one receipt line may carry (attached + awaited)', example: 10 })
  maxPerLine!: number;

  @ApiProperty({ description: 'The live photos one receipt may carry', example: 50 })
  maxPerReceipt!: number;

  @ApiProperty({ description: 'The largest photo upload, in bytes', example: 10485760 })
  maxBytes!: number;
}

/** Story 2-4a — GET …/receiving/goods-receipts/{grnId}/lines response. */
export class GoodsReceiptLinesResponse {
  @ApiProperty({ type: [GoodsReceiptLineEntryDto], description: 'The GRN\'s lines, in receipt order' })
  items!: GoodsReceiptLineEntryDto[];
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

  @ApiProperty({ required: false, type: [String], description: "Story 2-6a — on a serial line's over-receipt: the serial numbers of the excess, in capture order (they book when approved). Present only when the excess carries serials" })
  serials?: readonly string[];
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
    enum: [...SERIAL_FORMATS],
    description:
      "Story 2-6a: the serial format (`free` | `imei`) — the device's offline serial gate. A device whose snapshot lacks it (a pre-2-6a server) refuses to receive a serial-tracked SKU rather than capture anonymously",
  })
  serialFormat!: string;

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
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: 3650,
    description:
      "Story 2-4b: the SKU's total shelf life in days from manufacture, or null. A receipt line of a batch-tracked SKU with a mfg date and no typed expiry gets expiry = mfg + this (server-side); the handheld previews it. Absent (an older server) or null = no preview",
  })
  shelfLifeDays!: number | null;

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

  @ApiProperty({
    required: false,
    description:
      'Story 3-1: the SKU is a kit (a kit holds no stock — the handheld refuses a move of it offline). An older server omits it; the device reads absence as false',
  })
  isKit?: boolean;
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

  @ApiProperty({
    required: false,
    description:
      "Story 2-4b — the server sets a batch's expiry from mfg + the SKU's shelfLifeDays when no expiry is typed (the device previews it). Absent (an older server) reads as true",
  })
  deriveExpiry?: boolean;
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
  @ApiProperty({
    enum: ['normal', 'high', 'urgent'],
    description:
      "Story 4-2a — the order's priority (order-level, repeated on each of its SKU rows): the pack card's chip. Pack tasks arrive by the urgency key (due first, priority, ship-by, then oldest).",
  })
  orderPriority!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description: "Story 4-2a — the order's ship-by date (IST, YYYY-MM-DD); null when none.",
  })
  orderShipByDate!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Story 4-2a — the cash to collect on delivery for this order, integer paise; null means prepaid.",
  })
  codAmountPaise!: number | null;

  @ApiProperty({
    required: false,
    description:
      "Story 4-2c — what the order ORDERED of this SKU (its lines' quantities, base units). Below it, `pickedQty` ships short and the rest follows as a separate (backorder) order. Absent on a device snapshot from before 4-2c.",
  })
  orderedQty?: number;

  @ApiProperty({
    required: false,
    description:
      'Story 4-2c — true when ANY line of the order was picked below its quantity (order-level, repeated on each of its SKU rows — a SKU that picked nothing has no row of its own): the bench warns "Short — the rest ships later as a follow-on order", and on a COD order that the courier collects the full amount on this parcel.',
  })
  orderShortfall?: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: "Story 4-2c — the order's place in a backorder chain (the label suffix `-BO{seq}`; the pack card's \"Backorder\" chip); null on an original order.",
  })
  followOnSeq?: number | null;
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
 * — the SKU to count. Story 3-5a made the count blind: the frozen
 * expectation stays on the server (the web task detail shows it).
 */
export class CatalogCountTaskLineDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  // Story 3-5a — the count is BLIND: no expected quantity reaches a device.
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
    description: 'The bin state epoch FROZEN at task start — informational: the submit reads the epoch from the task row for the equality compare, never from the device',
  })
  binStateEpoch!: number | null;

  @ApiProperty({ description: 'When the task was created (ISO-8601 UTC)' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Story 3-5b (additive) — the stock take this task counts for; null = a cycle count. The count stays blind — nothing else about the take rides the card',
  })
  stockTakeId!: string | null;

  @ApiProperty({ type: [CatalogCountTaskLineDto], description: 'The SKUs the task lists (blind — no expected quantity); every line must be counted at submit, and SKUs found in the bin may be added' })
  lines!: readonly CatalogCountTaskLineDto[];
}

/** Story 3-5b — one active stock take of the warehouse, as the device snapshot carries it. */
export class CatalogStockTakeDto {
  @ApiProperty({ format: 'uuid' })
  stockTakeId!: string;

  @ApiProperty({ type: [String], nullable: true, description: 'The zones frozen; null = the whole warehouse' })
  zoneIds!: string[] | null;

  @ApiProperty({ description: 'The freeze instant (ISO-8601 UTC)' })
  frozenAt!: string;

  @ApiProperty({ description: 'Pending count tasks of the take (recounts included)' })
  pendingTasks!: number;
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

/** Story 2-8b — one line of an open return to vendor as the device snapshot carries it. */
export class CatalogOpenVendorReturnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '1-based, the document order' })
  lineNo!: number;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The batch the pick must scan (null on an untracked SKU)' })
  batchCode!: string | null;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'Units to pick (base units) — the pick takes at most this' })
  qty!: number;
}

/** Story 2-8b — one draft return to vendor, the handheld's pick work. */
export class CatalogOpenVendorReturnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['vendor'], description: "The return shipment's kind (4-7c adds `client`)" })
  kind!: 'vendor';

  @ApiProperty({ description: 'RTV-0001' })
  code!: string;

  @ApiProperty({ description: "The vendor's frozen name" })
  vendorName!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ type: [CatalogOpenVendorReturnLineDto] })
  lines!: readonly CatalogOpenVendorReturnLineDto[];
}

/** Story 4-7c (A10) — one line of an open return to client as the device snapshot carries it. */
export class CatalogOpenClientReturnLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '1-based, the document order' })
  lineNo!: number;

  @ApiProperty({ enum: ['returns', 'damaged'], description: 'Where the units are picked from — the Returns area or the Damaged area' })
  source!: 'returns' | 'damaged';

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The batch the pick must scan (null on an untracked SKU)' })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'A serial line: the serial the pick must scan (picked 0 or 1)' })
  serialNumber!: string | null;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'Units to pick (base units) — the pick takes at most this' })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The RMA the returned units came back on (returns lines)' })
  rmaCode!: string | null;
}

/** Story 4-7c (A10) — one draft return to client, the handheld's pick work. */
export class CatalogOpenClientReturnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['client'], description: "The return shipment's kind" })
  kind!: 'client';

  @ApiProperty({ description: 'RTC-0001' })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: "The brand's frozen name (the consignee)" })
  clientName!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ type: [CatalogOpenClientReturnLineDto] })
  lines!: readonly CatalogOpenClientReturnLineDto[];
}

/** Story 3-1 — one move reason as the device snapshot carries it. */
export class CatalogMoveReasonDto {
  @ApiProperty({ enum: ['consolidate', 're-slot', 'make-room', 'found-misplaced', 'client-request', 'other'] })
  code!: string;

  @ApiProperty({ description: 'The reason needs a note beside it (the reason `other`)' })
  noteRequired!: boolean;
}

/** Story 3-2b — one adjustment reason of the device snapshot (code + the operator-facing label). */
export class CatalogAdjustReasonDto {
  @ApiProperty({ enum: [...ADJUSTMENT_REASON_CODES] })
  code!: string;

  @ApiProperty({ description: 'The operator-facing label (the web uses the same words)' })
  label!: string;
}

/** Story 4-4a — one parcel's live shipment, as the device reads it. */
export class CatalogDispatchParcelShipmentDto {
  @ApiProperty({ format: 'uuid' }) shipmentId!: string;
  @ApiProperty({ enum: ['client-label', 'courier-label'] }) kind!: string;
  @ApiProperty({ description: 'The AWB as stored (normalised)' }) awb!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty() labelVerified!: boolean;
}

/** Story 4-4a — one parcel awaiting a courier. */
export class CatalogDispatchParcelDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ description: 'The parcel tag code (`O` + the order id’s last 16 hex digits)' }) parcelTagCode!: string;
  @ApiProperty({ enum: ['accepted', 'ready_to_dispatch'] }) status!: string;
  @ApiProperty({ type: CatalogDispatchParcelShipmentDto, nullable: true }) shipment!: CatalogDispatchParcelShipmentDto | null;
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

  @ApiProperty({ type: [PickTaskDto], description: 'Story 4.3 (additive): the pick tasks of every ready picklist on a released wave — story 4-2a: whole picklists by urgency (the most urgent planned order of each picklist, judged on the snapshot IST date), each in walk order (the bin/batch each names is advisory — the server re-derives both at pick time)' })
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
    type: [CatalogStockTakeDto],
    description:
      'Story 3-5b (additive): the warehouse\'s counting (and posting) stock takes — the handheld groups their count tasks by zone and refuses movements into or out of a frozen bin (bins[].frozen). An older server omits it',
  })
  stockTakes!: readonly CatalogStockTakeDto[];

  @ApiProperty({
    type: [CatalogOpenReturnDto],
    description:
      'Story 13-2 (additive): the warehouse\'s return authorizations that can still receive (open or partially received) — the handheld receives returned units against them offline, grading each unit; units not on an authorization are queued for review, never refused on the device',
  })
  openReturns!: readonly CatalogOpenReturnDto[];

  @ApiProperty({
    type: [CatalogOpenVendorReturnDto],
    description:
      "Story 2-8b (additive): the warehouse's DRAFT returns to vendor, oldest first — the handheld's Returns out tab picks them scan-verified (rtv.pick). An older server omits it",
  })
  openVendorReturns!: readonly CatalogOpenVendorReturnDto[];

  @ApiProperty({
    type: [CatalogOpenClientReturnDto],
    description:
      "Story 4-7c (additive): the warehouse's DRAFT returns to client, oldest first — the handheld's Returns out tab picks them scan-verified (rtc.pick) beside the returns to vendor. An older server omits it",
  })
  openClientReturns!: readonly CatalogOpenClientReturnDto[];

  @ApiProperty({
    type: [CatalogSnapshotClientDto],
    description:
      'Story 1-1 (additive): every client referenced by a SKU or an open document of the snapshot — the names the device shows when a scan belongs to another client, and the blind receipt\'s client picker. A snapshot WITHOUT this field (an older server) puts the device in legacy mode: no picker, no clientId sent',
  })
  clients!: readonly CatalogSnapshotClientDto[];

  @ApiProperty({
    type: [CatalogOpenGateInDto],
    description:
      'Story 2-3a (additive): the warehouse\'s open gate-ins — not gated out, gated in within the last 7 days, at most 200, newest first (decision 15). The dock records their unload and receives against them. An older server omits it',
  })
  openGateIns!: readonly CatalogOpenGateInDto[];

  @ApiProperty({
    type: [CatalogDockAppointmentDto],
    description:
      "Story 2-3b (additive): the warehouse's BOOKED dock appointments starting today (IST, server clock), at most 100, by start — the Receive tab's read-only \"Expected today\". The device derives \"Not arrived\" from endsAt + graceMinutes against its own clock. An older server omits it",
  })
  dockAppointments!: readonly CatalogDockAppointmentDto[];

  @ApiProperty({
    enum: [...DAMAGE_REASON_CODES],
    isArray: true,
    description:
      'Story 2-4a (additive): the damage reason vocabulary — the handheld shows its Damaged control only when the snapshot carries it (an older server omits it), and refuses to confirm a draft holding damage against a snapshot without it',
  })
  receiptDamageReasons!: readonly string[];

  @ApiProperty({
    enum: [...SHORT_REASON_CODES],
    isArray: true,
    description: 'Story 2-4a (additive): the short reason vocabulary — the Short control\'s gate, as receiptDamageReasons',
  })
  receiptShortReasons!: readonly string[];

  @ApiProperty({
    type: CatalogReceiptPhotosDto,
    description:
      "Story 2-5a (additive): damage photos on a receipt line — whether storage is on (the Photo button's gate) and the caps the draft must respect. An older server omits it, and the handheld then offers no Photo",
  })
  receiptPhotos!: CatalogReceiptPhotosDto;

  @ApiProperty({
    type: [CatalogMoveReasonDto],
    description:
      'Story 3-1 (additive): the bin-to-bin move\'s reason vocabulary, in order — the handheld\'s reason chips. A reason with noteRequired needs a note (up to 200 characters). An older server omits it, and the handheld then offers no Move stock',
  })
  moveReasons!: readonly CatalogMoveReasonDto[];

  @ApiProperty({
    type: [CatalogAdjustReasonDto],
    description:
      "Story 3-2b (additive): the stock adjustment's reason vocabulary with labels, in order — the handheld's Adjust reason chips (every reason needs the note the adjustment always carries). An older server omits it, and the handheld then offers no Adjust",
  })
  adjustReasons!: readonly CatalogAdjustReasonDto[];

  @ApiProperty({
    type: [CatalogDispatchParcelDto],
    description:
      "Story 4-4a (additive): the parcels awaiting a courier — the warehouse's packed orders, plus its accepted orders holding a live client-arranged shipment (never one with a carrier shipment), at most 2000, oldest first. The pack bench verifies a client label against it; the handover matches scanned AWBs and parcel tags against it. An older server omits it (the device reads it as empty)",
  })
  dispatchParcels!: readonly CatalogDispatchParcelDto[];

  @ApiProperty({ description: 'Story 4-4a (additive): true when dispatchParcels was capped at 2000 — hand over newer parcels on the web, or refresh later' })
  dispatchParcelsTruncated!: boolean;
}

// ── story 2-9a: the GRN document ────────────────────────────────────────────

const GRN_QC_STATUS_ENUM = ['on-hold', 'released', 'inspected'] as const;

/** Story 2-9a (A17) — `?format=pdf|csv` on the document file routes: required, a 400 when absent or anything else. */
export class GrnDocumentFileQueryDto {
  @ApiProperty({ enum: ['pdf', 'csv'], description: 'The file: the A4 PDF, or the lines as CSV (UTF-8 with BOM)' })
  @IsIn(['pdf', 'csv'])
  format!: 'pdf' | 'csv';
}

export class GrnAddressDto {
  @ApiProperty()
  line1!: string;

  @ApiProperty({ type: String, nullable: true })
  line2!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty({ description: "The warehouse's state name, or a client/vendor address's `State code {nn}`" })
  state!: string;

  @ApiProperty()
  pincode!: string;
}

export class GrnPartyDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  legalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: GrnAddressDto, nullable: true })
  address!: GrnAddressDto | null;
}

export class GrnWarehousePartyDto extends GrnPartyDto {
  @ApiProperty({ description: 'The warehouse operator (the tenant)' })
  operatorName!: string;
}

export class GrnPartiesDto {
  @ApiProperty({ description: 'True when the parties were frozen at receipt; false on a GRN recorded before frozen documents (the parties are the current ones)' })
  frozen!: boolean;

  @ApiProperty({ type: GrnWarehousePartyDto, description: 'Received at — no contact name or phone' })
  warehouse!: GrnWarehousePartyDto;

  @ApiProperty({ type: GrnPartyDto, nullable: true, description: 'The owner of the goods; null on an older mixed-client receipt' })
  client!: GrnPartyDto | null;

  @ApiProperty({ type: GrnPartyDto, nullable: true, description: 'The supplier as on the PO (frozen at PO creation); null on an ASN or blind receipt' })
  vendor!: GrnPartyDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'The supplier block in words when there is no vendor (an ASN, a blind receipt, a PO without one)' })
  supplierNote!: string | null;
}

export class GrnDocumentRefDto {
  @ApiProperty({ enum: ['po', 'asn', 'blind'] })
  kind!: 'po' | 'asn' | 'blind';

  @ApiProperty({ type: String, nullable: true })
  code!: string | null;

  @ApiProperty({ type: String, nullable: true })
  blindReasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  blindReasonLabel!: string | null;

  @ApiProperty({ description: '"PO P-1", "ASN A-77" or "Blind receipt (Unannounced delivery)"' })
  label!: string;
}

export class GrnArrivalDocumentDto {
  @ApiProperty({ enum: ['invoice', 'challan', 'bill_of_entry'] })
  kind!: string;

  @ApiProperty()
  number!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  date!: string;

  @ApiProperty({ type: String, nullable: true })
  ewayBillNo!: string | null;
}

export class GrnArrivalDto {
  @ApiProperty()
  gateInCode!: string;

  @ApiProperty({ type: String, nullable: true })
  vehicleNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  containerNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lrNumber!: string | null;

  @ApiProperty({ enum: ['intact', 'broken', 'none'] })
  sealStatus!: string;

  @ApiProperty({ type: String, nullable: true })
  sealNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  dockDoor!: string | null;

  @ApiProperty()
  gatedInAt!: string;

  @ApiProperty({ type: String, nullable: true })
  unloadStartedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  unloadEndedAt!: string | null;

  @ApiProperty({ type: [GrnArrivalDocumentDto], description: "Only this GRN's own documents (a shared truck's other paperwork is omitted)" })
  documents!: readonly GrnArrivalDocumentDto[];

  @ApiProperty({ description: 'True when the gate-in carried documents this GRN does not show' })
  documentsOmitted!: boolean;
}

export class GrnExcessDto {
  @ApiProperty()
  pendingQty!: number;

  @ApiProperty()
  approvedQty!: number;

  @ApiProperty()
  rejectedQty!: number;
}

export class GrnLineQcDto {
  @ApiProperty({ type: String, nullable: true, enum: [...GRN_QC_STATUS_ENUM, null] })
  status!: (typeof GRN_QC_STATUS_ENUM)[number] | null;

  @ApiProperty({ description: 'Released + passed + failed + still on hold' })
  heldQty!: number;

  @ApiProperty()
  releasedQty!: number;

  @ApiProperty()
  passedQty!: number;

  @ApiProperty()
  failedQty!: number;
}

export class GrnDocumentLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1 })
  lineNo!: number;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: 'The current SKU name (item descriptions are not frozen)' })
  skuName!: string;

  @ApiProperty({ description: "The line SKU's client" })
  clientCode!: string;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'Decimal places of the UoM' })
  uomPrecision!: number;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'IST calendar date' })
  mfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'IST calendar date' })
  expiryDate!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['typed', 'derived', null] })
  expirySource!: 'typed' | 'derived' | null;

  @ApiProperty({ type: Number, nullable: true, description: "The PO line's ordered or the ASN line's announced quantity, as at print" })
  expectedQty!: number | null;

  @ApiProperty({ description: 'Good units (an excess included)' })
  goodQty!: number;

  @ApiProperty()
  damagedQty!: number;

  @ApiProperty({ type: String, nullable: true })
  damageReasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  damageReasonLabel!: string | null;

  @ApiProperty()
  shortQty!: number;

  @ApiProperty({ type: String, nullable: true })
  shortReasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  shortReasonLabel!: string | null;

  @ApiProperty({ description: 'Units booked within the over-receipt tolerance' })
  toleranceQty!: number;

  @ApiProperty({ type: GrnExcessDto })
  excess!: GrnExcessDto;

  @ApiProperty({ type: GrnLineQcDto })
  qc!: GrnLineQcDto;

  @ApiProperty({ description: 'Serials captured (applied + awaiting approval)' })
  serialCount!: number;

  @ApiProperty()
  unreadableSerialCount!: number;

  @ApiProperty()
  rejectedSerialCount!: number;

  @ApiProperty({ description: 'Attached damage photos' })
  photoCount!: number;
}

export class GrnUomTotalsDto {
  @ApiProperty()
  uom!: string;

  @ApiProperty()
  goodQty!: number;

  @ApiProperty()
  damagedQty!: number;

  @ApiProperty()
  shortQty!: number;
}

export class GrnTotalsDto {
  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ type: [GrnUomTotalsDto], description: 'Per UoM, in first-appearance order' })
  byUom!: readonly GrnUomTotalsDto[];
}

/** Story 2-9a — `GET …/receiving/goods-receipts/{grnId}/document`. */
export class GoodsReceiptDocumentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'When the goods were received (the device time)' })
  receivedAt!: string;

  @ApiProperty()
  recordedAt!: string;

  @ApiProperty({ description: 'The read instant (over-receipt and QC are as at this time)' })
  printedAt!: string;

  @ApiProperty({ type: GrnPartiesDto })
  parties!: GrnPartiesDto;

  @ApiProperty({ type: GrnDocumentRefDto })
  document!: GrnDocumentRefDto;

  @ApiProperty({ type: GrnArrivalDto, nullable: true, description: 'Only when a gate-in is linked; as recorded on the gate-in' })
  arrival!: GrnArrivalDto | null;

  @ApiProperty({ type: [GrnDocumentLineDto] })
  lines!: readonly GrnDocumentLineDto[];

  @ApiProperty({ type: GrnTotalsDto })
  totals!: GrnTotalsDto;
}
