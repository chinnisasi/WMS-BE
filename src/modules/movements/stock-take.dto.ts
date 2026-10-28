import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { STOCK_TAKE_STATUSES } from '../../shared/db/schema';
import { MAX_RECOUNT_BINS, MAX_STOCK_TAKE_NOTE, MAX_STOCK_TAKE_ZONES } from './stock-take.command';

/**
 * Story 3-5b — the stock take's HTTP DTOs. The shape rules the command owns
 * (1–50 unique zones, 1–500 unique bins, a 200-character note, the digest's
 * hex shape) are checked there too, so a direct facade caller gets the same
 * 400s.
 */

// ── inputs ───────────────────────────────────────────────────────────────

export class StartStockTakeDto {
  @ApiProperty({
    required: false,
    nullable: true,
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_STOCK_TAKE_ZONES,
    uniqueItems: true,
    description: 'The zones to freeze and count (1–50, each once); absent or null = the whole warehouse',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STOCK_TAKE_ZONES)
  @IsUUID('all', { each: true })
  zoneIds?: string[] | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: MAX_STOCK_TAKE_NOTE })
  @IsOptional()
  @IsString()
  @Length(0, MAX_STOCK_TAKE_NOTE * 2)
  note?: string | null;
}

export class RecountStockTakeBinsDto {
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1, maxItems: MAX_RECOUNT_BINS, uniqueItems: true, description: 'Bins of the stock take to recount (1–500, each once)' })
  @IsArray()
  @ArrayMaxSize(MAX_RECOUNT_BINS)
  @IsUUID('all', { each: true })
  binIds!: string[];
}

export class CloseStockTakeDto {
  @ApiProperty({
    minLength: 64,
    maxLength: 64,
    description: 'The `openVarianceDigest` the stock take detail served when the variances were reviewed — a mismatch is 409 stock-take-changed',
  })
  @IsString()
  @Length(64, 64)
  openVarianceDigest!: string;
}

export class AbandonStockTakeDto {
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: MAX_STOCK_TAKE_NOTE })
  @IsOptional()
  @IsString()
  @Length(0, MAX_STOCK_TAKE_NOTE * 2)
  note?: string | null;
}

export class StockTakeListQuery {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: [...STOCK_TAKE_STATUSES] })
  @IsOptional()
  @IsIn(STOCK_TAKE_STATUSES as unknown as string[])
  status?: (typeof STOCK_TAKE_STATUSES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export const STOCK_TAKE_VARIANCE_FILTER = ['open', 'adjusted', 'recounted'] as const;

export class StockTakeVariancesQuery {
  @ApiProperty({ required: false, enum: [...STOCK_TAKE_VARIANCE_FILTER] })
  @IsOptional()
  @IsIn(STOCK_TAKE_VARIANCE_FILTER as unknown as string[])
  status?: (typeof STOCK_TAKE_VARIANCE_FILTER)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export const STOCK_TAKE_REPORT_FORMATS = ['csv', 'xlsx'] as const;

export class StockTakeReportQuery {
  @ApiProperty({ enum: [...STOCK_TAKE_REPORT_FORMATS] })
  @IsIn(STOCK_TAKE_REPORT_FORMATS as unknown as string[])
  format!: (typeof STOCK_TAKE_REPORT_FORMATS)[number];

  @ApiProperty({ required: false, format: 'uuid', description: "Only this client's (SKU, bin) rows; an unknown client is 404" })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

// ── outputs ──────────────────────────────────────────────────────────────

export class StockTakeSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: [String], nullable: true, description: 'Sorted; null = the whole warehouse' })
  zoneIds!: string[] | null;

  @ApiProperty({ enum: [...STOCK_TAKE_STATUSES] })
  status!: (typeof STOCK_TAKE_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ description: 'Bins frozen at the start' })
  binCount!: number;

  @ApiProperty({ format: 'uuid' })
  startedBy!: string;

  @ApiProperty({ description: 'The freeze instant (ISO-8601 UTC)' })
  startedAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  approvedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  closedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  abandonedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  abandonedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The abandon note (the start note stays in `note`)' })
  abandonNote!: string | null;

  @ApiProperty({ description: 'Handheld writes admitted after the freeze on bins already released (the detail totals add the live rows)' })
  deviceWrites!: number;

  @ApiProperty({ type: Number, nullable: true })
  postedCount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  unpostedCount!: number | null;
}

export class StartStockTakeResponse {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty({ description: 'Pending cycle tasks already on an in-scope bin, now counted for the take' })
  adoptedTaskCount!: number;

  @ApiProperty()
  createdTaskCount!: number;

  @ApiProperty({ description: 'Older open variances on in-scope bins marked recounted against the take' })
  supersededVarianceCount!: number;
}

export class StockTakeRecountEntryDto {
  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ format: 'uuid' })
  taskId!: string;
}

export class RecountStockTakeResponse {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty({ type: [StockTakeRecountEntryDto] })
  recounts!: StockTakeRecountEntryDto[];

  @ApiProperty()
  recountedVarianceCount!: number;
}

export class UnpostedVarianceDto {
  @ApiProperty({ format: 'uuid' })
  varianceId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: "The adjustment guard's machine code, or basis-moved" })
  code!: string;

  @ApiProperty()
  detail!: string;

  @ApiProperty({ description: 'A batch-, serial- or catch-weight-tracked SKU — needs a batch- or serial-level count (not yet supported)' })
  needsLotCount!: boolean;
}

export class CloseStockTakeResponse {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty()
  postedCount!: number;

  @ApiProperty({ type: [UnpostedVarianceDto], description: 'Variances left open (they stay on the variance queue)' })
  unposted!: UnpostedVarianceDto[];
}

export class AbandonStockTakeResponse {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty()
  cancelledTaskCount!: number;

  @ApiProperty({ description: 'Pending tasks a variance names as its recount — released to the cycle queue (still pending), not cancelled' })
  releasedTaskCount!: number;
}

export class StockTakeProgressDto {
  @ApiProperty()
  bins!: number;

  @ApiProperty({ description: 'Bins with a completed count and no pending task' })
  counted!: number;

  @ApiProperty({ description: 'Pending count tasks (recounts included)' })
  pending!: number;
}

export class StockTakeListEntryDto {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty({ type: StockTakeProgressDto })
  progress!: StockTakeProgressDto;
}

export class StockTakeListResponse {
  @ApiProperty({ type: [StockTakeListEntryDto] })
  items!: StockTakeListEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class StockTakeTotalsDto extends StockTakeProgressDto {
  @ApiProperty()
  recountPending!: number;

  @ApiProperty()
  withVariance!: number;

  @ApiProperty()
  openVariances!: number;

  @ApiProperty({ description: 'Open variances over their frozen threshold — the post needs the owner' })
  overThreshold!: number;

  @ApiProperty({ description: 'Handheld writes admitted on the frozen bins after the freeze' })
  deviceWrites!: number;
}

export class StockTakeZoneDto {
  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty()
  zoneCode!: string;

  @ApiProperty()
  bins!: number;

  @ApiProperty()
  counted!: number;

  @ApiProperty()
  pending!: number;

  @ApiProperty()
  withVariance!: number;
}

export class StockTakeBinRefDto {
  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;
}

export class StockTakeDetailResponse {
  @ApiProperty({ type: StockTakeSummaryDto })
  stockTake!: StockTakeSummaryDto;

  @ApiProperty({ type: StockTakeTotalsDto })
  totals!: StockTakeTotalsDto;

  @ApiProperty({ type: [StockTakeZoneDto] })
  zones!: StockTakeZoneDto[];

  @ApiProperty({ type: [StockTakeBinRefDto], description: 'Counted bins that moved since their count (up to 50) — recount them before posting' })
  recountRequiredBins!: StockTakeBinRefDto[];

  @ApiProperty()
  recountRequiredCount!: number;

  @ApiProperty({ description: "The close's approval token over the open variances — send it back on close" })
  openVarianceDigest!: string;
}

export class StockTakeVarianceEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  taskId!: string;

  @ApiProperty({ format: 'uuid' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty()
  zoneCode!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ description: 'Base units — the book quantity the count was compared against' })
  expectedQuantity!: number;

  @ApiProperty()
  countedQuantity!: number;

  @ApiProperty()
  delta!: number;

  @ApiProperty({ enum: ['open', 'adjusted', 'recounted'] })
  status!: string;

  @ApiProperty({ type: Number, nullable: true })
  thresholdQuantity!: number | null;

  @ApiProperty({ description: 'Over the frozen threshold — owner only' })
  overThreshold!: boolean;

  @ApiProperty()
  epochConflict!: boolean;

  @ApiProperty({ description: "The variance belongs to its bin's latest take task" })
  latest!: boolean;

  @ApiProperty({ description: 'Needs a batch- or serial-level count (not yet supported) — cannot be posted' })
  needsLotCount!: boolean;

  @ApiProperty({ type: String, nullable: true, description: "The close's refusal code once closed and left unposted" })
  unpostedCode!: string | null;
}

export class StockTakeVarianceListResponse {
  @ApiProperty({ type: [StockTakeVarianceEntryDto] })
  items!: StockTakeVarianceEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}
