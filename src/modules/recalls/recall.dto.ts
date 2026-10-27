import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { UUID_RE } from '../../shared/primitives/ids';
import {
  RECALL_EVIDENCE_MAX,
  RECALL_MAX_LOTS,
  RECALL_MODES,
  RECALL_NOTE_MAX,
  RECALL_REF_MAX,
  RECALL_STATUSES,
  type RecallMode,
  type RecallStatus,
} from './recall.command';

/**
 * Story 3-7a — the batch recall's HTTP shapes. The edge bounds only the body
 * (array sizes, a generous string cap); every rule the command owns — text in
 * code points after trimming, distinct ids, blank = absent — runs in the
 * command above its transaction (A18), so a malformed request is 400 there,
 * with one wording, whatever the surface.
 */

const BODY_TEXT_CAP = 2000;

// ── requests ─────────────────────────────────────────────────────────────────

/** `POST …/inventory/recalls` body. */
export class OpenRecallDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: RECALL_MAX_LOTS,
    description: `The batches (lots) recalled — 1–${RECALL_MAX_LOTS} distinct batch ids, every one a SKU of ONE client (resolve them from client + lot code with GET …/inventory/recalls/candidates)`,
  })
  @IsArray()
  @ArrayMaxSize(RECALL_MAX_LOTS * 2)
  @IsString({ each: true })
  batchIds!: string[];

  @ApiProperty({
    minLength: 1,
    maxLength: RECALL_NOTE_MAX,
    description: `Why the lot is recalled — VISIBLE TO THE CLIENT on its portal and in the report. Trimmed, 1–${RECALL_NOTE_MAX} characters`,
  })
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  reasonNote!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: RECALL_REF_MAX,
    description: `The brand's own recall reference (one vendor lot across several clients is one recall per client, linked by this). Trimmed, blank = none, at most ${RECALL_REF_MAX} characters`,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  externalRef?: string | null;

  @ApiProperty({
    required: false,
    enum: [...RECALL_MODES],
    default: 'live',
    description: '`live` blocks every active lot it names; `mock` (a drill) blocks nothing and affects no pick, dispatch, unblock or wind-down — its trace and report are identical, labelled MOCK',
  })
  @IsOptional()
  @IsIn(RECALL_MODES)
  mode?: RecallMode;
}

/** `POST …/inventory/recalls/{recallId}/batches` body (A14). */
export class AddRecallBatchesDto {
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, maxItems: RECALL_MAX_LOTS, description: `1–${RECALL_MAX_LOTS} more batches of the recall's client` })
  @IsArray()
  @ArrayMaxSize(RECALL_MAX_LOTS * 2)
  @IsString({ each: true })
  batchIds!: string[];
}

export class RecallDispositionNoteDto {
  @ApiProperty({ format: 'uuid', description: 'A lot of this recall' })
  @IsString()
  batchId!: string;

  @ApiProperty({ minLength: 1, maxLength: RECALL_NOTE_MAX, description: 'What became of the lot (destroyed under certificate …, returned to the brand …) — 1–500 characters' })
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  note!: string;
}

/** `POST …/inventory/recalls/{recallId}/close` body (A5, A6). */
export class CloseRecallDto {
  @ApiProperty({ minLength: 1, maxLength: RECALL_NOTE_MAX, description: 'Why the recall is closed — trimmed, 1–500 characters' })
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  note!: string;

  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    maxItems: RECALL_MAX_LOTS,
    description:
      'The lots to unblock (0–50, distinct): each must be one THIS recall blocked and still blocked for the recall. A lot with stock on hand, in transit or in open orders needs overrideReason. Every other lot stays blocked (unblock it later through the batch)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECALL_MAX_LOTS * 2)
  @IsString({ each: true })
  releaseBatchIds?: string[];

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: RECALL_NOTE_MAX, description: 'Why released lots may carry stock — audited on each lot’s unblock. Trimmed, blank = none' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  overrideReason?: string | null;

  @ApiProperty({ required: false, default: false, description: 'Close even though a lot’s stock does not match its ledger history (unaccounted ≠ 0) — audited' })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnaccounted?: boolean;

  @ApiProperty({ required: false, type: () => [RecallDispositionNoteDto], maxItems: RECALL_MAX_LOTS, description: 'Up to one note per lot, frozen in the close summary' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RECALL_MAX_LOTS * 2)
  @ValidateNested({ each: true })
  @Type(() => RecallDispositionNoteDto)
  dispositionNotes?: RecallDispositionNoteDto[];

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: RECALL_EVIDENCE_MAX, description: 'A destruction certificate number or similar — 1–200 characters, blank = none' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(BODY_TEXT_CAP)
  evidenceRef?: string | null;
}

/** `GET …/inventory/recalls` query. */
export class RecallListQueryDto {
  @ApiProperty({ required: false, format: 'uuid', description: "One client's recalls" })
  @IsOptional()
  @Matches(UUID_RE, { message: 'clientId must be a uuid' })
  clientId?: string;

  @ApiProperty({ required: false, enum: [...RECALL_STATUSES] })
  @IsOptional()
  @IsIn(RECALL_STATUSES)
  status?: RecallStatus;

  @ApiProperty({ required: false, enum: [...RECALL_MODES] })
  @IsOptional()
  @IsIn(RECALL_MODES)
  mode?: RecallMode;

  @ApiProperty({ required: false, maxLength: RECALL_REF_MAX, description: "The brand's reference, exactly (one vendor lot recalled for several clients shares it)" })
  @IsOptional()
  @IsString()
  @MaxLength(RECALL_REF_MAX)
  externalRef?: string;

  @ApiProperty({ required: false, example: 'RCL-000001', description: 'One recall by its code, exactly — how a link that names a recall code (a batch under recall) finds it' })
  @IsOptional()
  @Matches(/^RCL-[0-9]{6,9}$/, { message: 'code must be a recall code RCL-nnnnnn' })
  code?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** `GET …/inventory/recalls/candidates` query (A9). */
export class RecallCandidatesQueryDto {
  @ApiProperty({ format: 'uuid', description: 'The client whose SKUs are searched' })
  @Matches(UUID_RE, { message: 'clientId must be a uuid' })
  clientId!: string;

  @ApiProperty({ minLength: 1, maxLength: 100, description: 'The lot code as printed — matched on letters and digits only, case-insensitively (`ab-12/3` finds `AB123`)' })
  @IsString()
  @MaxLength(100)
  code!: string;
}

/** A paged recall list's query (`bins`, `shipments`, `receipts`, the portal list). */
export class RecallPageQueryDto {
  @ApiProperty({ required: false, description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export const RECALL_REPORT_FORMATS = ['csv', 'xlsx'] as const;

/** `GET …/recalls/{recallId}/report` query. */
export class RecallReportQueryDto {
  @ApiProperty({ enum: [...RECALL_REPORT_FORMATS], description: '`csv` (streamed, every row, ends in a `section=end` row carrying the count) or `xlsx` (built whole, capped at 200,000 rows)' })
  @IsIn(RECALL_REPORT_FORMATS)
  format!: (typeof RECALL_REPORT_FORMATS)[number];
}

// ── responses ────────────────────────────────────────────────────────────────

export class RecallFiguresDto {
  @ApiProperty({ description: 'Σ received (grn.received), base units' })
  received!: number;
  @ApiProperty({ description: 'Σ received damaged (grn.damaged)' })
  receivedDamaged!: number;
  @ApiProperty({ description: 'On hand in every warehouse, excluding in-transit' })
  onHand!: number;
  @ApiProperty({ description: 'In an IN-TRANSIT bin (a transfer not yet confirmed)' })
  inTransit!: number;
  @ApiProperty({ description: 'Picked into open orders (net per order line)' })
  heldInOpenOrders!: number;
  @ApiProperty({ description: 'Picked into dispatched orders (net per order line)' })
  dispatched!: number;
  @ApiProperty({ description: 'Σ returned (return.received)' })
  returned!: number;
  @ApiProperty({ description: 'Σ returned units scrapped (return.scrapped)' })
  returnScrapped!: number;
  @ApiProperty({ description: 'Σ written off (negative stock adjustments)' })
  adjustedOut!: number;
  @ApiProperty({ description: 'The ledger history − on hand − in transit: 0 unless the projection diverged (or the lot sits in a quarantined scope)' })
  unaccounted!: number;
}

export class RecallLotSnapshotDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty({ format: 'uuid' })
  skuId!: string;
  @ApiProperty({ description: 'True when this recall blocked the lot; false when it was already blocked for another reason (it keeps that reason), and on every mock lot' })
  blockedByRecall!: boolean;
}

export class CloseSummaryLotDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty({ format: 'uuid' })
  skuId!: string;
  @ApiProperty({ type: RecallFiguresDto })
  figures!: RecallFiguresDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, description: 'Written off per adjustment reason code' })
  adjustedOutByReason!: Record<string, number>;
  @ApiProperty()
  released!: boolean;
  @ApiProperty({ type: String, nullable: true })
  overrideReason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  dispositionNote!: string | null;
}

export class CloseSummaryDto {
  @ApiProperty({ enum: [1] })
  v!: 1;
  @ApiProperty({ description: 'The close instant the figures are as of' })
  asOf!: string;
  @ApiProperty({ type: [CloseSummaryLotDto] })
  lots!: CloseSummaryLotDto[];
  @ApiProperty()
  acknowledgedUnaccounted!: boolean;
  @ApiProperty({ type: String, nullable: true })
  evidenceRef!: string | null;
}

export class RecallSnapshotDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ example: 'RCL-000001' })
  code!: string;
  @ApiProperty({ format: 'uuid' })
  clientId!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
  @ApiProperty({ enum: [...RECALL_STATUSES] })
  status!: RecallStatus;
  @ApiProperty()
  reasonNote!: string;
  @ApiProperty({ type: String, nullable: true })
  externalRef!: string | null;
  @ApiProperty()
  openedAt!: string;
  @ApiProperty({ format: 'uuid' })
  openedBy!: string;
  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  closedBy!: string | null;
  @ApiProperty({ type: String, nullable: true })
  closeNote!: string | null;
  @ApiProperty({ type: [String], nullable: true, description: 'The lots the close unblocked; null while open' })
  releasedBatchIds!: string[] | null;
  @ApiProperty({ type: CloseSummaryDto, nullable: true })
  closeSummary!: CloseSummaryDto | null;
  @ApiProperty({ type: [RecallLotSnapshotDto] })
  lots!: RecallLotSnapshotDto[];
}

/** The open / add / close answer — the stored idempotency snapshot. */
export class RecallResponse {
  @ApiProperty({ type: RecallSnapshotDto })
  recall!: RecallSnapshotDto;
}

export class RecallListEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty({ format: 'uuid' })
  clientId!: string;
  @ApiProperty()
  clientCode!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
  @ApiProperty({ enum: [...RECALL_STATUSES] })
  status!: RecallStatus;
  @ApiProperty()
  reasonNote!: string;
  @ApiProperty({ type: String, nullable: true })
  externalRef!: string | null;
  @ApiProperty()
  openedAt!: string;
  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;
  @ApiProperty()
  lotCount!: number;
}

export class RecallListResponse {
  @ApiProperty({ type: [RecallListEntryDto] })
  items!: RecallListEntryDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class RecallOnRecallDto {
  @ApiProperty({ format: 'uuid' })
  recallId!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
}

export class RecallCandidateDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty({ format: 'uuid' })
  skuId!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  skuName!: string;
  @ApiProperty()
  uom!: string;
  @ApiProperty({ enum: ['active', 'blocked'] })
  status!: string;
  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  expiryDate!: string | null;
  @ApiProperty({ enum: ['exact', 'normalised'], description: '`exact` — the stored code equals the input; `normalised` — only letters and digits match: a similar code, check the label' })
  match!: 'exact' | 'normalised';
  @ApiProperty({ description: 'On hand across every warehouse (in transit included), base units' })
  onHand!: number;
  @ApiProperty({ type: RecallOnRecallDto, nullable: true, description: 'The open recall naming this batch, null when none' })
  onRecall!: RecallOnRecallDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'An open recall of the client naming another batch of the same lot code — add this one to it (A14); null when none' })
  sameCodeOnOpenRecall!: string | null;
}

export class RecallCandidatesResponse {
  @ApiProperty({ description: 'The code as matched — letters and digits, upper-cased' })
  normalisedCode!: string;
  @ApiProperty({ description: 'More batches matched than the 200 listed — narrow the code (the checklist is not complete)' })
  truncated!: boolean;
  @ApiProperty({ type: [RecallCandidateDto] })
  items!: RecallCandidateDto[];
}

export class RecallHeaderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
  @ApiProperty({ enum: [...RECALL_STATUSES] })
  status!: RecallStatus;
  @ApiProperty({ format: 'uuid' })
  clientId!: string;
  @ApiProperty()
  clientCode!: string;
  @ApiProperty()
  clientName!: string;
  @ApiProperty()
  reasonNote!: string;
  @ApiProperty({ type: String, nullable: true })
  externalRef!: string | null;
  @ApiProperty()
  openedAt!: string;
  @ApiProperty({ format: 'uuid' })
  openedBy!: string;
  @ApiProperty({ type: String, nullable: true })
  openedByName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  closedBy!: string | null;
  @ApiProperty({ type: String, nullable: true })
  closedByName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  closeNote!: string | null;
  @ApiProperty({ type: String, nullable: true })
  evidenceRef!: string | null;
  @ApiProperty({ type: Boolean, nullable: true })
  acknowledgedUnaccounted!: boolean | null;
  @ApiProperty({ type: String, nullable: true, description: 'The first report download (any surface)' })
  firstReportAt!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Seconds from open to the first report download — null before one' })
  timeToReportSeconds!: number | null;
}

export class RecallLotDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty({ format: 'uuid' })
  skuId!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  skuName!: string;
  @ApiProperty()
  uom!: string;
  @ApiProperty({ type: String, nullable: true })
  expiryDate!: string | null;
  @ApiProperty({ enum: ['active', 'blocked'], description: 'The batch now' })
  status!: string;
  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;
  @ApiProperty()
  expired!: boolean;
  @ApiProperty()
  blockedByRecall!: boolean;
  @ApiProperty({ description: 'The close released this lot' })
  released!: boolean;
  @ApiProperty({ type: RecallFiguresDto, description: 'Live, as of the read' })
  figures!: RecallFiguresDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  adjustedOutByReason!: Record<string, number>;
  @ApiProperty({ type: RecallFiguresDto, nullable: true, description: 'Frozen at close; null while open' })
  closeFigures!: RecallFiguresDto | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, nullable: true })
  closeAdjustedOutByReason!: Record<string, number> | null;
  @ApiProperty({ type: String, nullable: true })
  overrideReason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  dispositionNote!: string | null;
}

export class RecallOnHandDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty({ description: '`storage`, or a system bin: RECEIVING, QC-HOLD, DAMAGED, RETURNS, IN-TRANSIT' })
  role!: string;
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  quantity!: number;
}

export class RecallHeldOrderDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;
  @ApiProperty({ description: "The client's order number, else the channel reference, else the id's last eight characters" })
  orderLabel!: string;
  @ApiProperty({ type: String, nullable: true })
  clientOrderRef!: string | null;
  @ApiProperty({ type: String, nullable: true })
  channelOrderRef!: string | null;
  @ApiProperty()
  status!: string;
  @ApiProperty()
  warehouseId!: string;
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  quantity!: number;
  @ApiProperty()
  lastPickedAt!: string;
}

export class RecallPlannedPickDto {
  @ApiProperty({ format: 'uuid' })
  picklistLineId!: string;
  @ApiProperty({ format: 'uuid' })
  orderId!: string;
  @ApiProperty()
  orderLabel!: string;
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty()
  binCode!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  quantity!: number;
}

export class RecallDetailResponse {
  @ApiProperty({ type: RecallHeaderDto })
  recall!: RecallHeaderDto;
  @ApiProperty({ description: 'The instant the live figures are as of' })
  asOf!: string;
  @ApiProperty({ type: [RecallLotDto] })
  lots!: RecallLotDto[];
  @ApiProperty({ type: [RecallOnHandDto], description: 'Per lot × warehouse × location role — never a bin' })
  onHandByWarehouse!: RecallOnHandDto[];
  @ApiProperty({ type: [RecallHeldOrderDto], description: 'Open orders holding picked units — dispatch refuses them while the recall is open' })
  heldOrders!: RecallHeldOrderDto[];
  @ApiProperty({ type: [RecallPlannedPickDto], description: 'Planned picks at a bin holding a recalled lot — they refuse until the recalled units are moved out' })
  plannedPicks!: RecallPlannedPickDto[];
}

export class RecallBinDto {
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty()
  binCode!: string;
  @ApiProperty()
  role!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  quantity!: number;
}

export class RecallBinsResponse {
  @ApiProperty({ type: [RecallBinDto] })
  items!: RecallBinDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class RecallShipmentDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;
  @ApiProperty()
  orderLabel!: string;
  @ApiProperty({ type: String, nullable: true })
  clientOrderRef!: string | null;
  @ApiProperty({ type: String, nullable: true })
  channelOrderRef!: string | null;
  @ApiProperty({ type: String, nullable: true })
  consigneeLegalName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  consigneeGstin!: string | null;
  @ApiProperty({ type: String, nullable: true })
  destinationCity!: string | null;
  @ApiProperty({ type: String, nullable: true })
  destinationState!: string | null;
  @ApiProperty({ type: String, nullable: true })
  destinationPincode!: string | null;
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  quantity!: number;
  @ApiProperty({ type: String, nullable: true })
  dispatchedAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  carrier!: string | null;
  @ApiProperty({ type: String, nullable: true })
  awb!: string | null;
  @ApiProperty({ description: 'Dispatched after the recall opened' })
  duringRecall!: boolean;
}

export class RecallShipmentsResponse {
  @ApiProperty({ type: [RecallShipmentDto] })
  items!: RecallShipmentDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class RecallReceiptDto {
  @ApiProperty()
  grnCode!: string;
  @ApiProperty({ type: String, nullable: true, description: '`PO <code>`, `ASN <code>` or `blind <reason>`' })
  document!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "The PO's vendor; null on an ASN or blind receipt" })
  vendorName!: string | null;
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  quantity!: number;
  @ApiProperty()
  receivedAt!: string;
  @ApiProperty({ description: 'Received after the recall opened (the lot stayed blocked)' })
  duringRecall!: boolean;
}

export class RecallReceiptsResponse {
  @ApiProperty({ type: [RecallReceiptDto] })
  items!: RecallReceiptDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

// ── the portal (exact allowlists — A11) ──────────────────────────────────────

export class PortalRecallListEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
  @ApiProperty({ enum: [...RECALL_STATUSES] })
  status!: RecallStatus;
  @ApiProperty({ type: String, nullable: true })
  externalRef!: string | null;
  @ApiProperty()
  openedAt!: string;
  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;
  @ApiProperty()
  lotCount!: number;
}

export class PortalRecallListResponse {
  @ApiProperty({ type: [PortalRecallListEntryDto] })
  items!: PortalRecallListEntryDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalRecallLotDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  skuCode!: string;
  @ApiProperty()
  skuName!: string;
  @ApiProperty()
  uom!: string;
  @ApiProperty({ type: String, nullable: true })
  expiryDate!: string | null;
  @ApiProperty({ type: RecallFiguresDto })
  figures!: RecallFiguresDto;
  @ApiProperty({ type: RecallFiguresDto, nullable: true })
  closeFigures!: RecallFiguresDto | null;
}

export class PortalRecallOnHandDto {
  @ApiProperty()
  warehouseCode!: string;
  @ApiProperty()
  role!: string;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  quantity!: number;
}

export class PortalRecallHeldOrderDto {
  @ApiProperty()
  orderLabel!: string;
  @ApiProperty({ type: String, nullable: true })
  clientOrderRef!: string | null;
  @ApiProperty()
  batchCode!: string;
  @ApiProperty()
  quantity!: number;
}

export class PortalRecallDetailResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty({ enum: [...RECALL_MODES] })
  mode!: RecallMode;
  @ApiProperty({ enum: [...RECALL_STATUSES] })
  status!: RecallStatus;
  @ApiProperty({ type: String, nullable: true })
  externalRef!: string | null;
  @ApiProperty()
  reasonNote!: string;
  @ApiProperty()
  openedAt!: string;
  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  closeNote!: string | null;
  @ApiProperty({ type: [PortalRecallLotDto] })
  lots!: PortalRecallLotDto[];
  @ApiProperty({ type: [PortalRecallOnHandDto] })
  onHandByWarehouse!: PortalRecallOnHandDto[];
  @ApiProperty({ type: [PortalRecallHeldOrderDto] })
  heldOrders!: PortalRecallHeldOrderDto[];
}
