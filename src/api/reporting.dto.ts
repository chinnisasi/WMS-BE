import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { UUID_RE } from '../shared/primitives/ids';
import { MAX_SERVICE_REPORT_DAYS, SERVICE_TARGET_HOURS, SYNC_HEALTH_REASONS, SYNC_HEALTH_STATES } from '../modules/reporting/reporting.facade';
import type { ServiceReport } from '../modules/reporting/reporting.facade';

/**
 * Story 9-1 — the Overview's response shape. One flat DTO class per tile
 * (no generics, no inheritance — the generated FE client reads each tile's
 * own type). Every figure is `{ value, drill }`: `value` is null when the
 * tile is `unavailable` or the figure has no data (an empty median or
 * ratio); `drill` is ALWAYS present, so even an unavailable tile names the
 * list behind it.
 */

const TILE_STATES = ['ok', 'unavailable'] as const;

const STATE_DESCRIPTION =
  "`ok`: every figure was computed. `unavailable`: the tile timed out, missed the overall deadline, or failed — every value is null (there is no 'estimated' state)";

export class ReportingDrillDto {
  @ApiProperty({
    description:
      'The API route (relative to /api/v1, ids filled in) whose rows are behind the figure — e.g. /tenants/{t}/warehouses/{w}/outbound/picklist-lines',
  })
  apiPath!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The exact query to send it. Windowed figures carry from and to (to = asOf, exclusive)',
  })
  query!: Record<string, string>;

  @ApiProperty({
    description:
      'True: paging apiPath?query to exhaustion yields exactly the figure. False for rates, medians and ratios — and for figures whose list cannot express the exact filter',
  })
  reconciles!: boolean;
}

export class ReportingFigureDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Null when the tile is unavailable or the figure has no data' })
  value!: number | null;

  @ApiProperty({ type: ReportingDrillDto })
  drill!: ReportingDrillDto;
}

export class ReportingWindowedFigureDto {
  @ApiProperty({ type: ReportingFigureDto, description: 'Today so far — the IST calendar day of asOf' })
  today!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Today plus the previous six IST days' })
  d7!: ReportingFigureDto;
}

export class DockToStockTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Median minutes from GRN creation to bin placement, over placements in the window (negative intervals excluded); null with no placement' })
  medianMinutes!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: GRN lines whose applied stock still sits in Receiving — the putaway task list' })
  awaitingPutaway!: ReportingFigureDto;
}

export class PickRateTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Pick lines recorded (one per line — a serial draw is one line)' })
  pickLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Pick lines recorded in the hour before asOf' })
  lastHour!: ReportingFigureDto;
}

export class ShortPicksTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Picklist lines flipped to short in the window — zero-unit (empty-bin) shorts included' })
  shortLines!: ReportingWindowedFigureDto;
}

export class GrnVariancesTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Over-receipts requested in the window' })
  overReceipts!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: over-receipts awaiting a decision' })
  pendingOverReceipts!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Blind GRNs (no purchase order — flagged for PO matching) recorded in the window' })
  blindGrns!: ReportingWindowedFigureDto;
}

export class OrderAccuracyTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-3: (short-picked lines + failed pack verifications) per 1,000 dispatched lines; null with no dispatched line' })
  defectsPer1000!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto })
  shortLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Failed pack verifications (recorded since countingSince)' })
  packFailures!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Order lines dispatched in the window' })
  dispatchedLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC — when failed pack verifications began to be recorded (no backfill)' })
  countingSince!: string | null;
}

export class OversellTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-4: channel orders accepted in the window with at least one backordered line (per order)' })
  backorderedOrders!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Channel orders refused under the reject backorder policy — oversell prevented (recorded since countingSince)' })
  prevented!: ReportingWindowedFigureDto;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC — when refusals began to be recorded (no backfill)' })
  countingSince!: string | null;
}

export class ExpiryAlertsTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: open expiry-upcoming alerts' })
  openExpiryUpcoming!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: open aged-stock alerts' })
  openAged!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Alerts of either kind raised in the window' })
  raised!: ReportingWindowedFigureDto;
}

export class SyncConnectionHealthDto {
  @ApiProperty({ format: 'uuid' })
  integrationId!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ enum: ['connected', 'disconnected'], description: 'A disconnected connection is always health error, reason disconnected' })
  status!: string;

  @ApiProperty({ enum: SYNC_HEALTH_STATES })
  health!: (typeof SYNC_HEALTH_STATES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SYNC_HEALTH_REASONS, null],
    description:
      "Why the health is not ok. disconnected / ingest-warehouse-unset (error — channel orders land nowhere); then /channels' own rule (connectionHealth): breaker-open (error), breaker-half-open, last-delivery-failed, never-synced, sync-lag (degraded); then ingest-failures (degraded — a genuine order-ingest failure in 24 h; refusals and settled cancellations are not failures). Null when ok",
  })
  reason!: (typeof SYNC_HEALTH_REASONS)[number] | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Seconds since the last successful availability sync; null when it never synced' })
  lagSeconds!: number | null;

  @ApiProperty({ description: 'Genuine order-ingest failures in the 24 h before asOf (a policy refusal or a settled cancellation is not one)' })
  ingestFailures24h!: number;
}

export class SyncHealthTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({
    type: [SyncConnectionHealthDto],
    nullable: true,
    description: 'Channel connections (connected or disconnected) ingesting into this warehouse or with no ingest warehouse set; null when unavailable',
  })
  connections!: SyncConnectionHealthDto[] | null;

  @ApiProperty({ type: ReportingDrillDto })
  drill!: ReportingDrillDto;
}

export class DispatchPipelineTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: orders accepted, not yet packed' })
  accepted!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: orders packed, ready to dispatch' })
  readyToDispatch!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: shipments labelled but not yet on a manifest (no list of their own — drills to the packed orders)' })
  labelledNotManifested!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Orders dispatched in the window' })
  ordersDispatched!: ReportingWindowedFigureDto;
}

export class Sm8TileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: "E-way bills queued in the window for this warehouse's invoices (dismissed bills and voided invoices excluded)" })
  eligible!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Of those, generated through the gateway' })
  gatewayGenerated!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-8: gatewayGenerated ÷ eligible, 0–1; null with none eligible. Reads 0 until a live gateway adapter exists' })
  gatewayShare!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: "This warehouse's invoices issued in the window" })
  invoicesIssued!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Secondary: the share (0–1) of those issued with no manually priced line; null with none issued' })
  noManualPricingShare!: ReportingWindowedFigureDto;
}

export class ReportingTilesDto {
  @ApiProperty({ type: DockToStockTileDto })
  dockToStock!: DockToStockTileDto;

  @ApiProperty({ type: PickRateTileDto })
  pickRate!: PickRateTileDto;

  @ApiProperty({ type: ShortPicksTileDto })
  shortPicks!: ShortPicksTileDto;

  @ApiProperty({ type: GrnVariancesTileDto })
  grnVariances!: GrnVariancesTileDto;

  @ApiProperty({ type: OrderAccuracyTileDto })
  orderAccuracy!: OrderAccuracyTileDto;

  @ApiProperty({ type: OversellTileDto })
  oversell!: OversellTileDto;

  @ApiProperty({ type: ExpiryAlertsTileDto })
  expiryAlerts!: ExpiryAlertsTileDto;

  @ApiProperty({ type: SyncHealthTileDto })
  syncHealth!: SyncHealthTileDto;

  @ApiProperty({ type: DispatchPipelineTileDto })
  dispatchPipeline!: DispatchPipelineTileDto;

  @ApiProperty({ type: Sm8TileDto })
  sm8!: Sm8TileDto;
}

export class ReportingWindowDto {
  @ApiProperty({ description: "ISO-8601 UTC — IST midnight of asOf's IST date (the start of today)" })
  todayFrom!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — IST midnight six days before todayFrom' })
  d7From!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — the exclusive end of every window (= asOf)' })
  to!: string;

  @ApiProperty({ description: "ISO-8601 UTC — asOf − 1 h: the pick rate's lastHour window start (its drill's from)" })
  lastHourFrom!: string;

  @ApiProperty({ description: "ISO-8601 UTC — asOf − 24 h: the sync tile's ingest-failure window start" })
  last24hFrom!: string;
}

export class ReportingOverviewResponse {
  @ApiProperty({ description: 'ISO-8601 UTC — the instant every figure was read at' })
  asOf!: string;

  @ApiProperty({ description: 'True whenever any tile is unavailable' })
  stale!: boolean;

  @ApiProperty({ type: ReportingWindowDto })
  window!: ReportingWindowDto;

  @ApiProperty({ type: ReportingTilesDto })
  tiles!: ReportingTilesDto;
}

// ── Story 21-8 — per-client service reporting ─────────────────────────────────

/**
 * The service report's query, shared by the operator and the portal route
 * (the `ClientUsageQuery` pattern: a value class bound to `@Query()`). It
 * checks SHAPE only — the period rules (real dates, `from ≤ to`, at most 366
 * days) are the facade's, so both routes refuse with identical details. A
 * `clientId` is not a member: `forbidNonWhitelisted` refuses it with 400.
 */
export class ServiceReportQuery {
  @ApiProperty({ example: '2026-09-01', description: 'First IST date of the period (inclusive), YYYY-MM-DD' })
  @IsString()
  from!: string;

  @ApiProperty({
    example: '2026-09-30',
    description: `Last IST date of the period (inclusive), YYYY-MM-DD — at most ${MAX_SERVICE_REPORT_DAYS} days after \`from\`, never before it`,
  })
  @IsString()
  to!: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'One warehouse of the tenant; absent means every warehouse' })
  @IsOptional()
  @Matches(UUID_RE, { message: 'warehouseId must be a uuid' })
  warehouseId?: string;
}

export class ServiceDockToStockDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Median minutes from the GRN being recorded to the placement being recorded, over this client\'s placements recorded in the period (negative intervals excluded), 1 dp; null with none',
  })
  medianMinutes!: number | null;

  @ApiProperty({ description: "Placements of this client's SKUs recorded in the period (the median's population)" })
  placements!: number;
}

export class ServicePickAccuracyDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Of the order lines dispatched in the period, the share that never had a short pick (a short later recovered still counts against the line), 0–1 to 4 dp; null with no line dispatched',
  })
  accuracy!: number | null;

  @ApiProperty({ description: "Order lines of this client's orders first dispatched in the period (one dispatch.dispatched event per line)" })
  linesDispatched!: number;

  @ApiProperty({ description: 'Of those lines, the ones with any short-picked picklist line' })
  linesShortPicked!: number;

  @ApiProperty({ description: "Failed pack verifications recorded in the period for this client's orders — shown beside the ratio, never folded into it" })
  packFailures!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When failed pack verifications began to be recorded (0058) — a period starting before it is a partial count; null if unknown',
  })
  packFailuresCountingSince!: string | null;
}

export class ServiceDispatchTimelinessDto {
  @ApiProperty({ description: "This client's orders first dispatched in the period — the same count the client is invoiced for" })
  ordersDispatched!: number;

  @ApiProperty({
    description:
      'Of those, the orders dispatched within targetHours of being received (orders.created_at — the server ingestion time, not the buyer order time)',
  })
  onTime!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'onTime ÷ ordersDispatched, 0–1 to 4 dp; null with none dispatched' })
  onTimeRate!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Median minutes from received to dispatched, over orders (clamped at 0), 1 dp; null with none' })
  medianMinutes!: number | null;

  @ApiProperty({
    description:
      'Orders received in the period, not cancelled, received more than targetHours before asOf, and not dispatched as of asOf — the backlog the dispatched figures cannot see',
  })
  lateNotDispatched!: number;
}

/** The service report — identical on the operator and the portal route, and carrying no client id. */
export class ServiceReportDto {
  @ApiProperty({ example: '2026-09-01', description: 'First IST date of the period (inclusive)' })
  from!: string;

  @ApiProperty({ example: '2026-09-30', description: 'Last IST date of the period (inclusive)' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The warehouse the report is narrowed to; null for every warehouse' })
  warehouseId!: string | null;

  @ApiProperty({ format: 'date-time', description: 'When the report was computed — the period is read up to here at most' })
  asOf!: string;

  @ApiProperty({ example: SERVICE_TARGET_HOURS, description: 'The dispatch timeliness target in hours (fixed)' })
  targetHours!: number;

  @ApiProperty({ type: ServiceDockToStockDto })
  dockToStock!: ServiceDockToStockDto;

  @ApiProperty({ type: ServicePickAccuracyDto })
  pickAccuracy!: ServicePickAccuracyDto;

  @ApiProperty({ type: ServiceDispatchTimelinessDto })
  dispatchTimeliness!: ServiceDispatchTimelinessDto;
}

/**
 * The facade's report onto the DTO, rebuilt key by key (never a spread), so
 * both routes answer exactly this allowlist — and never a client id.
 */
export function toServiceReportDto(report: ServiceReport): ServiceReportDto {
  return {
    from: report.from,
    to: report.to,
    warehouseId: report.warehouseId,
    asOf: report.asOf,
    targetHours: report.targetHours,
    dockToStock: {
      medianMinutes: report.dockToStock.medianMinutes,
      placements: report.dockToStock.placements,
    },
    pickAccuracy: {
      accuracy: report.pickAccuracy.accuracy,
      linesDispatched: report.pickAccuracy.linesDispatched,
      linesShortPicked: report.pickAccuracy.linesShortPicked,
      packFailures: report.pickAccuracy.packFailures,
      packFailuresCountingSince: report.pickAccuracy.packFailuresCountingSince,
    },
    dispatchTimeliness: {
      ordersDispatched: report.dispatchTimeliness.ordersDispatched,
      onTime: report.dispatchTimeliness.onTime,
      onTimeRate: report.dispatchTimeliness.onTimeRate,
      medianMinutes: report.dispatchTimeliness.medianMinutes,
      lateNotDispatched: report.dispatchTimeliness.lateNotDispatched,
    },
  };
}
