import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE, MIN_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../../shared/primitives/quantity';
import {
  DEFAULT_LABEL_SIZE,
  LABEL_FORMATS,
  LABEL_LAYOUTS,
  LABEL_SIZES,
  MAX_LABELS_PER_PRINT,
  type LabelFormat,
  type LabelLayout,
  type LabelSize,
} from '../../shared/labels/layout';
import { LPN_STATUSES, LPN_VOID_NOTE_MAX, LPN_VOID_REASON_CODES, type LpnStatus, type LpnVoidReasonCode } from './lpn.store';

/** Story 2-10b — a mint names at most this many GRN lines… */
export const MAX_LPN_MINT_LINES = 200;
/** …and at most this many labels in total (A5). */
export const MAX_LPN_MINT_QUANTITIES = 1000;
/** A5 — a line holds at most this many active plus placed LPNs. */
export const MAX_LPNS_PER_LINE = 5000;

// ── mint ────────────────────────────────────────────────────────────────────

export class MintLpnsLineDto {
  @ApiProperty({ format: 'uuid', description: 'A line of this goods receipt' })
  @IsUUID('all')
  grnLineId!: string;

  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: MAX_LPN_MINT_QUANTITIES,
    description: `One declared quantity per label, in request order (base units, each > 0). ${QUANTITY_FIELD_DESCRIPTION}`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LPN_MINT_QUANTITIES)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(MIN_QUANTITY_BASE, { each: true })
  @Max(MAX_QUANTITY_BASE, { each: true })
  quantities!: number[];
}

/** POST /tenants/{t}/receiving/goods-receipts/{grnId}/lpns — mint LPNs (`labels.execute`, keyed). */
export class MintLpnsRequestDto {
  @ApiProperty({
    type: [MintLpnsLineDto],
    minItems: 1,
    maxItems: MAX_LPN_MINT_LINES,
    description: `The lines to label (distinct), at most ${MAX_LPN_MINT_QUANTITIES} labels in total`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LPN_MINT_LINES)
  @ValidateNested({ each: true })
  @Type(() => MintLpnsLineDto)
  lines!: MintLpnsLineDto[];
}

// ── one LPN ─────────────────────────────────────────────────────────────────

export class LpnDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The licence plate code — `LPN-` and the tenant number, zero-padded to 6 digits; the barcode payload byte for byte' })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ format: 'uuid' })
  grnLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ format: 'uuid', description: "The SKU's client when the LPN was minted" })
  clientId!: string;

  @ApiProperty({ description: 'The declared quantity, base units' })
  qty!: number;

  @ApiProperty({ enum: [...LPN_STATUSES], description: '`active` (labelled, rides its putaway task), `placed` (a placement consumed it), `voided` (terminal; frees its quantity)' })
  status!: LpnStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, description: 'When a placement consumed it (server clock)' })
  placedAt!: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true })
  voidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...LPN_VOID_REASON_CODES, null] })
  voidReasonCode!: LpnVoidReasonCode | null;

  @ApiProperty({ type: String, nullable: true })
  voidNote!: string | null;
}

export class MintLpnsResponse {
  @ApiProperty({ format: 'uuid' })
  grnId!: string;

  @ApiProperty({ type: [LpnDto], description: 'The minted LPNs, in request order (code order)' })
  lpns!: LpnDto[];
}

export class LpnListResponse {
  @ApiProperty({ type: [LpnDto], description: "Every LPN of the goods receipt (any status), in code order" })
  items!: LpnDto[];
}

export class LpnResponse {
  @ApiProperty({ type: LpnDto })
  lpn!: LpnDto;
}

// ── void ────────────────────────────────────────────────────────────────────

/** POST …/lpns/{lpnId}/void — void an active LPN (`labels.execute`, keyed). */
export class VoidLpnRequestDto {
  @ApiProperty({ enum: [...LPN_VOID_REASON_CODES], description: 'Why the label is voided (`other` needs the note)' })
  @IsIn([...LPN_VOID_REASON_CODES])
  reasonCode!: LpnVoidReasonCode;

  @ApiProperty({ type: String, nullable: true, required: false, maxLength: LPN_VOID_NOTE_MAX, description: 'A note (trimmed, 1–200 characters; required with `other`)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  note?: string | null;
}

// ── print ───────────────────────────────────────────────────────────────────

/**
 * POST …/lpns/labels — print LPN labels (a read: no key, no audit). At most
 * one of `lpnIds` (1–1000 distinct LPNs of this receipt — a reprint) or
 * `grnLineId` (the line's non-voided LPNs); neither prints every non-voided
 * LPN of the receipt. `size` only with the `label` layout; `a4` only with
 * `pdf` — the cross-field rules are 400s in the controller.
 */
export class LpnLabelsRequestDto {
  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_LABELS_PER_PRINT,
    uniqueItems: true,
    description: 'The LPNs to print (distinct ids of this goods receipt). Send this, or `grnLineId`, or neither.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LABELS_PER_PRINT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  lpnIds?: string[];

  @ApiProperty({ required: false, format: 'uuid', description: "Print the non-voided LPNs of one line of this receipt. Send this, or `lpnIds`, or neither." })
  @IsOptional()
  @IsUUID('all')
  grnLineId?: string;

  @ApiProperty({ enum: [...LABEL_FORMATS], description: '`zpl` (Zebra thermal, 203 dpi) or `pdf`' })
  @IsIn([...LABEL_FORMATS])
  format!: LabelFormat;

  @ApiProperty({
    required: false,
    enum: [...LABEL_LAYOUTS],
    default: 'label',
    description: '`label` — one label per page or per ^XA…^XZ (default); `a4` — a 3 × 8 sheet of 70 × 36 mm cells (PDF only)',
  })
  @IsOptional()
  @IsIn([...LABEL_LAYOUTS])
  layout?: LabelLayout;

  @ApiProperty({
    required: false,
    enum: [...LABEL_SIZES],
    default: DEFAULT_LABEL_SIZE,
    description: 'The label size in inches (`label` layout only; sending it with `a4` is a 400)',
  })
  @IsOptional()
  @IsIn([...LABEL_SIZES])
  size?: LabelSize;
}
